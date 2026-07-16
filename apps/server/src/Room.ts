import { randomUUID } from "node:crypto";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { buildingContaining, buildingOfFloor, physicsFloorId } from "@dotbot/game/mapModel";
import { DotBotSimulation } from "@dotbot/game/simulation";
import { assignSquadInsertions, squadSpawnPosition, validateInsertionMap } from "@dotbot/game/insertion";
import type { BotSpawn, GameConfig, GameSnapshot, InputCommand, InsertionPoint, SimEvent } from "@dotbot/game/types";
import { filterEventsForViewer, filterForViewer, itemFromCode, itemToCode, toEntityMeta, toWireEvent, toWireSnapshot } from "@dotbot/protocol";
import { LOBBY_SQUADS } from "@dotbot/protocol";
import type { ClientMessage, LobbyMember, LobbySquadId, MatchIntel, RoomPhase, ServerMessage } from "@dotbot/protocol";
import type { WireItemCode } from "@dotbot/protocol";
import { NoopPersistence, type Persistence, type RunManifest } from "./db";

export interface RoomPeer {
  readonly id: string;
  send(message: ServerMessage): void;
}

type Member = LobbyMember & {
  token: string;
  peer: RoomPeer | null;
  botId: string | null;
  latestInput: InputCommand;
  latestSeq: number;
  handoffTimer: ReturnType<typeof setTimeout> | null;
  inRun: boolean;
  streaming: boolean;
  runOver: Extract<ServerMessage, { type: "runOver" }> | null;
  persistenceEligible: boolean;
  persistedOutcome: string | null;
  insertionName: string | null;
};

export type RoomBandwidthHealth = {
  code: string;
  bytesPerSecond: number;
  members: number;
};

type RoomOptions = {
  countdownMs?: number;
  config?: Partial<GameConfig>;
  now?: () => number;
  persistence?: Persistence;
  /** Test hook: disable AI squad backfill so scripted bots have no rivals for dots. */
  aiWingmates?: boolean;
  /** Test/replay hook; production uses random UUID match seeds. */
  matchIdFactory?: () => string;
};

const squads = LOBBY_SQUADS;
const squadColors = ["#ff3b6b", "#2f80ed", "#9b51e0"] as const;

export class Room {
  readonly code: string;
  phase: RoomPhase = "lobby";
  createdAt: number;
  endedAt: number | null = null;
  droppedTickMs = 0;

  private readonly members = new Map<string, Member>();
  private readonly memberByToken = new Map<string, Member>();
  private readonly countdownMs: number;
  private readonly config: GameConfig;
  private readonly now: () => number;
  private readonly persistence: Persistence;
  private simulation: DotBotSimulation | null = null;
  private hostId = "";
  private accumulatorMs = 0;
  private tickDurationMs = 1000 / defaultGameConfig.tickHz;
  private lastTickAt: number;
  private matchStartPromise: Promise<void> | null = null;
  private endTick = Number.MAX_SAFE_INTEGER;
  private bandwidthWindowBytes = 0;
  private bandwidthWindowStartedAt: number;
  private lastBytesPerSecond = 0;
  private matchId: string | null = null;
  private readonly pendingPersistence = new Set<Promise<void>>();
  private readonly matchOutcomes = new Map<string, string>();
  private readonly aiWingmates: boolean;
  private readonly matchIdFactory: () => string;
  private readonly matchIntel = new Map<string, MatchIntel>();

  constructor(code: string, options: RoomOptions = {}) {
    this.code = code;
    this.countdownMs = options.countdownMs ?? 3000;
    this.config = { ...defaultGameConfig, ...options.config };
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence ?? new NoopPersistence();
    this.aiWingmates = options.aiWingmates ?? true;
    this.matchIdFactory = options.matchIdFactory ?? randomUUID;
    this.createdAt = this.now();
    this.lastTickAt = this.createdAt;
    this.bandwidthWindowStartedAt = this.createdAt;
  }

  get size(): number {
    return this.members.size;
  }

  get connectedCount(): number {
    return [...this.members.values()].filter((member) => member.peer !== null).length;
  }

  get lobbyMembers(): LobbyMember[] {
    return [...this.members.values()].map(({ playerId, name, squadId }) => ({ playerId, name, squadId }));
  }

  get bandwidthHealth(): RoomBandwidthHealth {
    const elapsedSeconds = Math.max(0.001, (this.now() - this.bandwidthWindowStartedAt) / 1000);
    return {
      code: this.code,
      bytesPerSecond: Math.round(this.bandwidthWindowBytes > 0 ? this.bandwidthWindowBytes / elapsedSeconds : this.lastBytesPerSecond),
      members: this.members.size,
    };
  }

  join(peer: RoomPeer, token: string, requestedName: string, resolvedPlayerId?: string, preferredSquad?: LobbySquadId): Member | null {
    const existing = this.memberByToken.get(token);
    if (existing) {
      existing.peer = peer;
      existing.name = sanitizeName(requestedName);
      existing.streaming = true;
      if (existing.handoffTimer) {
        clearTimeout(existing.handoffTimer);
        existing.handoffTimer = null;
      }
      if (this.phase === "live" && existing.botId && existing.inRun) {
        this.simulation?.setController(existing.botId, "human");
      }
      this.sendWelcome(existing);
      if (this.phase === "live") {
        this.sendMatchStart(existing);
      }
      return existing;
    }

    if (this.phase !== "lobby" || this.members.size >= squads.length * 3) {
      return null;
    }

    const index = this.members.size;
    const member: Member = {
      playerId: resolvedPlayerId ?? `p-${token.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "") || index}`,
      token,
      name: sanitizeName(requestedName),
      squadId: this.availableSquad(preferredSquad),
      peer,
      botId: null,
      latestInput: { move: { x: 0, y: 0 }, dash: false },
      latestSeq: 0,
      handoffTimer: null,
      inRun: false,
      streaming: true,
      runOver: null,
      persistenceEligible: true,
      persistedOutcome: null,
      insertionName: null,
    };
    this.members.set(member.playerId, member);
    this.memberByToken.set(token, member);
    if (!this.hostId) {
      this.hostId = member.playerId;
    }
    this.sendWelcome(member);
    this.broadcastLobby();
    return member;
  }

  receive(playerId: string, message: Exclude<ClientMessage, { type: "hello" }>): void {
    const member = this.members.get(playerId);
    if (!member) return;

    switch (message.type) {
      case "startMatch":
        if (playerId !== this.hostId) {
          member.peer?.send({ type: "err", code: "not_host", msg: "Only the host can start the match." });
          return;
        }
        if (this.phase !== "lobby") {
          member.peer?.send({ type: "err", code: "bad_phase", msg: "The match has already started." });
          return;
        }
        this.beginCountdown();
        return;
      case "joinSquad": {
        if (this.phase !== "lobby") {
          member.peer?.send({ type: "err", code: "bad_phase", msg: "Squads lock when the host starts the match." });
          return;
        }
        if (!squads.includes(message.squadId)) {
          member.peer?.send({ type: "err", code: "bad_squad", msg: "Unknown squad." });
          return;
        }
        if (member.squadId === message.squadId) return;
        if (this.squadSize(message.squadId) >= 3) {
          member.peer?.send({ type: "err", code: "squad_full", msg: "That squad already has three players." });
          return;
        }
        member.squadId = message.squadId;
        this.broadcastLobby();
        return;
      }
      case "leaveRun":
        this.leaveRun(member);
        return;
      case "input":
        if (this.phase !== "live" || !member.inRun || message.seq <= member.latestSeq) return;
        member.latestSeq = message.seq;
        member.latestInput = {
          move: { x: message.move[0], y: message.move[1] },
          dash: message.dash,
          useBay: message.useBay,
          swapBay: message.swapBay,
          downedVerb: message.downedVerb,
          plea: message.plea,
        };
        return;
      case "ping":
        member.peer?.send({ type: "pong", cts: message.cts, sts: this.now() });
        return;
    }
  }

  disconnect(peerId: string): void {
    const member = [...this.members.values()].find((candidate) => candidate.peer?.id === peerId);
    if (!member) return;
    member.peer = null;

    if (this.phase === "lobby") {
      this.members.delete(member.playerId);
      this.memberByToken.delete(member.token);
      if (member.playerId === this.hostId) {
        this.hostId = this.members.keys().next().value ?? "";
      }
      this.broadcastLobby();
      return;
    }

    if (this.phase === "live" && member.botId && member.inRun) {
      this.simulation?.setController(member.botId, "frozen");
      member.handoffTimer = setTimeout(() => {
        member.handoffTimer = null;
        if (!member.peer && member.botId && this.phase === "live") {
          this.simulation?.setController(member.botId, "ai");
          this.recordDisconnected(member);
        }
      }, 15_000);

      if (this.connectedCount === 0) {
        this.end("all_humans_disconnected");
      }
    }
  }

  tick(now = this.now()): number[] {
    this.rollBandwidthWindow(now);
    if (this.phase !== "live" || !this.simulation) {
      this.lastTickAt = now;
      return [];
    }

    const elapsed = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    this.accumulatorMs += elapsed;
    const durations: number[] = [];
    let steps = 0;

    while (this.accumulatorMs >= this.tickDurationMs && steps < 5) {
      const started = performance.now();
      for (const member of this.members.values()) {
        if (!member.botId) continue;
        this.simulation.applyInput(member.botId, member.latestInput);
        member.latestInput = { move: member.latestInput.move, dash: false, downedVerb: member.latestInput.downedVerb, plea: false };
      }
      this.simulation.step();
      durations.push(performance.now() - started);
      this.accumulatorMs -= this.tickDurationMs;
      steps += 1;

      const snapshot = this.simulation.getSnapshot();
      const events = this.simulation.drainEvents();
      this.processRunEvents(events);
      if (events.length > 0) this.broadcastEvents(events, snapshot);

      if (snapshot.debug.tickCount % 3 === 0) {
        this.broadcastSnapshot(snapshot);
        if (events.length === 0) this.broadcastToStreams({ type: "ev", events: [] });
      }

      if (snapshot.debug.tickCount >= this.endTick) {
        this.timeoutRun(snapshot.bots);
      } else {
        this.completeIfNoActiveMembers();
      }

      if (this.phase !== "live") {
        this.accumulatorMs = 0;
        break;
      }
    }

    if (steps === 5 && this.accumulatorMs >= this.tickDurationMs) {
      this.droppedTickMs += this.accumulatorMs;
      this.accumulatorMs = 0;
    }
    return durations;
  }

  dispose(): void {
    for (const member of this.members.values()) {
      if (member.handoffTimer) clearTimeout(member.handoffTimer);
    }
    this.simulation?.dispose();
    this.simulation = null;
  }

  private beginCountdown(): void {
    this.phase = "countdown";
    this.broadcastLobby();
    this.matchStartPromise = new Promise((resolve) => setTimeout(resolve, this.countdownMs)).then(() => this.startMatch());
  }

  private async startMatch(): Promise<void> {
    if (this.phase !== "countdown") return;
    const simulation = await DotBotSimulation.create({ map: downtownMap, config: this.config });
    for (const spawn of downtownMap.botSpawns) simulation.removeBot(spawn.id);

    validateInsertionMap(downtownMap, squads.length, this.config.botRadius);
    const assignmentSeed = this.matchIdFactory();
    this.matchId = assignmentSeed;
    this.matchOutcomes.clear();
    this.matchIntel.clear();
    try {
      await this.persistence.startMatch({
        matchId: this.matchId,
        roomCode: this.code,
        mapId: downtownMap.id,
        startedAt: new Date(this.now()),
      });
    } catch (error) {
      console.warn(`[persistence] failed to start match ${this.matchId}; continuing statelessly. ${errorMessage(error)}`);
      this.matchId = null;
    }

    const loadouts = new Map<string, WireItemCode[]>();
    const insertionPreferences = new Map<string, string | null>();
    const intelObjects = new Map<string, import("@dotbot/game/types").BaseObjectKind[]>();
    for (const member of this.members.values()) {
      try {
        loadouts.set(member.playerId, await this.persistence.consumeLoadout(member.playerId));
      } catch (error) {
        console.warn(`[persistence] failed to consume loadout for ${member.playerId}; using default spawn. ${errorMessage(error)}`);
      }
      try {
        insertionPreferences.set(member.playerId, await this.persistence.getInsertionPreference(member.playerId));
      } catch (error) {
        insertionPreferences.set(member.playerId, null);
        console.warn(`[persistence] failed to read insertion preference for ${member.playerId}; assigning without it. ${errorMessage(error)}`);
      }
      try {
        intelObjects.set(member.playerId, await this.persistence.getMatchIntelObjects(member.playerId));
      } catch (error) {
        intelObjects.set(member.playerId, []);
        console.warn(`[persistence] failed to read match intel furniture for ${member.playerId}; omitting intel. ${errorMessage(error)}`);
      }
    }

    const activeSquads = squads.filter((squadId) => [...this.members.values()].some((member) => member.squadId === squadId));
    const insertionAssignments = assignSquadInsertions({
      squads: activeSquads.map((squadId) => ({
        squadId,
        members: [...this.members.values()]
          .filter((member) => member.squadId === squadId)
          .map((member) => ({ playerId: member.playerId, preference: insertionPreferences.get(member.playerId) ?? null })),
      })),
      points: downtownMap.insertionPoints,
      matchId: assignmentSeed,
      minSpacing: this.config.minInsertionSpacing,
    });
    const insertionBySquad = new Map(insertionAssignments.map((assignment) => [assignment.squadId, assignment.point]));

    const squadCounts = new Map<string, number>();
    for (const member of this.members.values()) {
      const squadIndex = squads.indexOf(member.squadId as (typeof squads)[number]);
      const count = squadCounts.get(member.squadId) ?? 0;
      const insertion = insertionBySquad.get(member.squadId)!;
      const botId = `human-${member.playerId}`;
      simulation.spawnBot(makeSpawn(botId, member.name, member.squadId, squadColors[squadIndex], insertion, count, loadouts.get(member.playerId) ?? [], this.config.botRadius), "human");
      member.botId = botId;
      member.inRun = true;
      member.streaming = true;
      member.runOver = null;
      member.persistenceEligible = true;
      member.persistedOutcome = null;
      member.insertionName = insertion.name;
      squadCounts.set(member.squadId, count + 1);
    }

    for (const [squadId, count] of squadCounts) {
      if (!this.aiWingmates || count >= 2) continue;
      const squadIndex = squads.indexOf(squadId as (typeof squads)[number]);
      const insertion = insertionBySquad.get(squadId)!;
      simulation.spawnBot(
        makeSpawn(`ai-${squadId}`, `${squadId} wing`, squadId, squadColors[squadIndex], insertion, count, [], this.config.botRadius),
        "ai",
      );
    }
    for (const spawn of downtownMap.botSpawns.filter((candidate) => candidate.isAmbient)) {
      simulation.spawnBot(spawn, "ai");
    }

    const spawnSnapshot = simulation.getSnapshot();
    const greyDensity = downtownMap.buildings.map((building) => ({
      buildingId: building.id,
      buildingName: building.name,
      count: spawnSnapshot.bots.filter((bot) => bot.isAmbient && bot.state === "alive" && buildingIdForBot(bot.floorId, bot.position) === building.id).length,
    }));
    const blueprintDots = spawnSnapshot.dots.filter((dot) => dot.active && dot.item.kind === "blueprint")
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const member of this.members.values()) {
      const owned = intelObjects.get(member.playerId) ?? [];
      const intel: MatchIntel = {};
      if (owned.includes("listeningPost")) intel.greyDensity = greyDensity;
      if (owned.includes("signalMast") && blueprintDots.length > 0) {
        const dot = blueprintDots[stableIndex(`${assignmentSeed}:${member.playerId}`, blueprintDots.length)];
        if (dot.item.kind === "blueprint") {
          intel.signal = {
            dotId: dot.id,
            blueprintId: dot.item.blueprintId,
            position: { ...dot.position },
            floorId: dot.floorId,
            expiresAtTick: spawnSnapshot.debug.tickCount + Math.ceil(this.config.signalIntelDurationMs / (1000 / simulation.config.tickHz)),
          };
        }
      }
      if (intel.greyDensity || intel.signal) this.matchIntel.set(member.playerId, intel);
    }

    this.simulation = simulation;
    this.tickDurationMs = 1000 / simulation.config.tickHz;
    this.endTick = Math.ceil(simulation.config.runDurationMs / this.tickDurationMs);
    this.accumulatorMs = 0;
    this.lastTickAt = this.now();
    this.phase = "live";
    for (const member of this.members.values()) this.sendMatchStart(member);
  }

  private sendWelcome(member: Member): void {
    member.peer?.send({
      type: "welcome",
      playerId: member.playerId,
      roomCode: this.code,
      phase: this.phase,
      members: this.lobbyMembers,
      hostId: this.hostId,
      locked: this.phase !== "lobby",
    });
  }

  private broadcastLobby(): void {
    this.broadcast({ type: "lobby", members: this.lobbyMembers, hostId: this.hostId, locked: this.phase !== "lobby" });
  }

  private squadSize(squadId: LobbySquadId): number {
    return [...this.members.values()].filter((member) => member.squadId === squadId).length;
  }

  private availableSquad(preferred?: LobbySquadId): LobbySquadId {
    if (preferred && squads.includes(preferred) && this.squadSize(preferred) < 3) return preferred;
    return [...squads].sort((left, right) => this.squadSize(left) - this.squadSize(right) || squads.indexOf(left) - squads.indexOf(right))[0];
  }

  private sendMatchStart(member: Member): void {
    if (!member.botId || !this.simulation) return;
    const snapshot = this.simulation.getSnapshot();
    member.peer?.send({
      type: "matchStart",
      map: downtownMap,
      config: this.simulation.config,
      yourBotId: member.botId,
      meta: snapshot.bots.map(toEntityMeta),
      tickHz: this.simulation.config.tickHz,
      endTick: this.endTick,
      insertionName: member.insertionName ?? "UNKNOWN",
      intel: this.matchIntel.get(member.playerId),
    });
    if (member.runOver) member.peer?.send(member.runOver);
  }

  private broadcastSnapshot(snapshot: ReturnType<DotBotSimulation["getSnapshot"]>): void {
    const wire = toWireSnapshot(snapshot);
    const meta = snapshot.bots.map(toEntityMeta);
    for (const member of this.members.values()) {
      if (!member.streaming || !member.peer) continue;
      const filtered = filterForViewer(wire, meta, this.viewerContext(member, snapshot));
      this.sendStream(member, { type: "snap", ...filtered, ack: member.latestSeq });
    }
  }

  private end(reason: string): void {
    if (this.phase === "ended") return;
    if (reason === "all_humans_disconnected") {
      for (const member of this.members.values()) {
        if (member.inRun && !member.peer) this.recordDisconnected(member);
      }
    }
    this.phase = "ended";
    this.endedAt = this.now();
    const pending = [...this.pendingPersistence];
    void Promise.allSettled(pending).then(async () => {
      this.broadcast({ type: "matchEnd", reason });
      if (!this.matchId) return;
      try {
        await this.persistence.finishMatch({
          matchId: this.matchId,
          endedAt: new Date(this.endedAt ?? this.now()),
          summary: {
            reason,
            participants: [...this.matchOutcomes].map(([playerId, outcome]) => ({ playerId, outcome })),
          },
        });
      } catch (error) {
        console.warn(`[persistence] failed to finish match ${this.matchId}; teardown continued. ${errorMessage(error)}`);
      }
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const member of this.members.values()) member.peer?.send(message);
  }

  private broadcastToStreams(message: ServerMessage): void {
    for (const member of this.members.values()) {
      if (member.streaming && member.peer) this.sendStream(member, message);
    }
  }

  private broadcastEvents(events: SimEvent[], snapshot: GameSnapshot): void {
    const meta = snapshot.bots.map(toEntityMeta);
    for (const member of this.members.values()) {
      if (!member.streaming || !member.peer) continue;
      const includedBotIds = this.includedBotIds(member, snapshot);
      this.sendStream(member, {
        type: "ev",
        events: filterEventsForViewer(events, meta, includedBotIds, member.squadId).map(toWireEvent),
      });
    }
  }

  private viewerContext(member: Member, snapshot: GameSnapshot) {
    return {
      map: downtownMap,
      squadId: member.squadId,
      viewerBotId: member.botId ?? undefined,
      squadPhysicsFloorIds: this.squadPhysicsFloorIds(member, snapshot),
      intel: this.snapshotIntel(member, snapshot),
    };
  }

  private snapshotIntel(member: Member, snapshot: GameSnapshot): MatchIntel | undefined {
    const intel = this.matchIntel.get(member.playerId);
    if (!intel) return undefined;
    const signal = intel.signal;
    if (!signal) return {};
    const active = snapshot.debug.tickCount < signal.expiresAtTick
      && snapshot.dots.some((dot) => dot.id === signal.dotId && dot.active);
    return active ? { signal } : {};
  }

  private squadPhysicsFloorIds(member: Member, snapshot: GameSnapshot): Set<string> {
    return new Set(snapshot.bots
      .filter((bot) => bot.squadId === member.squadId && bot.state === "alive")
      .map((bot) => physicsFloorId(downtownMap, bot.floorId)));
  }

  private includedBotIds(member: Member, snapshot: GameSnapshot): Set<string> {
    const own = snapshot.bots.find((bot) => bot.id === member.botId);
    const spectator = !own || own.state === "consumed";
    const floors = spectator
      ? this.squadPhysicsFloorIds(member, snapshot)
      : new Set([physicsFloorId(downtownMap, own.floorId)]);
    return new Set(snapshot.bots
      .filter((bot) => bot.squadId === member.squadId || floors.has(physicsFloorId(downtownMap, bot.floorId)))
      .map((bot) => bot.id));
  }

  private sendStream(member: Member, message: ServerMessage): void {
    this.bandwidthWindowBytes += Buffer.byteLength(JSON.stringify(message));
    member.peer?.send(message);
  }

  private rollBandwidthWindow(now: number): void {
    const elapsedMs = now - this.bandwidthWindowStartedAt;
    if (elapsedMs < 30_000) return;
    this.lastBytesPerSecond = Math.round(this.bandwidthWindowBytes / Math.max(0.001, elapsedMs / 1000));
    console.info(`[room ${this.code}] ${this.lastBytesPerSecond} B/s across ${this.members.size} members`);
    this.bandwidthWindowBytes = 0;
    this.bandwidthWindowStartedAt = now;
  }

  private processRunEvents(events: SimEvent[]): void {
    for (const event of events) {
      if (event.type !== "extracted" && event.type !== "consumed") continue;
      const member = [...this.members.values()].find((candidate) => candidate.botId === event.botId);
      if (!member?.inRun) continue;
      this.sendRunOver(member, event.type === "extracted"
        ? { type: "runOver", reason: "extracted", keptItems: event.items.map(itemToCode), lostItems: [], learnedBlueprints: [] }
        : { type: "runOver", reason: "died", keptItems: [], lostItems: event.lostItems.map(itemToCode), learnedBlueprints: [] },
      event.type === "extracted" ? event.items : []);
    }
  }

  private sendRunOver(member: Member, message: Extract<ServerMessage, { type: "runOver" }>, cargo: import("@dotbot/game/types").Item[] = []): void {
    member.inRun = false;
    member.latestInput = { move: { x: 0, y: 0 }, dash: false };
    member.runOver = message;
    this.matchOutcomes.set(member.playerId, message.reason);
    const persistenceWrite = this.persistRunOutcome(member, message, cargo).then((manifest) => {
      message.keptItems = manifest.keptItems;
      message.lostItems = manifest.lostItems;
      message.learnedBlueprints = manifest.learnedBlueprints;
      if (manifest.contractCompletions?.length) message.contractCompletions = manifest.contractCompletions;
      member.runOver = message;
    });
    this.trackPersistence(persistenceWrite, () => member.peer?.send(message));
  }

  private timeoutRun(bots: ReturnType<DotBotSimulation["getSnapshot"]>["bots"]): void {
    for (const member of this.members.values()) {
      if (!member.inRun) continue;
      const bot = bots.find((candidate) => candidate.id === member.botId);
      const lostItems = bot ? [...bot.bays.filter((item): item is NonNullable<typeof item> => item !== null), ...bot.hold] : [];
      this.sendRunOver(member, { type: "runOver", reason: "timeout", keptItems: [], lostItems: lostItems.map(itemToCode), learnedBlueprints: [] });
    }
    this.end("timeout");
  }

  private completeIfNoActiveMembers(): void {
    if (this.phase === "live" && [...this.members.values()].every((member) => !member.inRun)) {
      this.end("complete");
    }
  }

  private leaveRun(member: Member): void {
    if (member.inRun && member.botId) {
      const bot = this.simulation?.getSnapshot().bots.find((candidate) => candidate.id === member.botId);
      if (bot?.state === "downed") {
        const lostItems = [...bot.bays.filter((item): item is NonNullable<typeof item> => item !== null), ...bot.hold];
        this.simulation?.removeBot(member.botId);
        this.sendRunOver(member, {
          type: "runOver",
          reason: "died",
          keptItems: [],
          lostItems: lostItems.map(itemToCode),
          learnedBlueprints: [],
        });
        this.completeIfNoActiveMembers();
        return;
      }
      this.recordDisconnected(member);
      this.simulation?.removeBot(member.botId);
      member.inRun = false;
    }
    member.streaming = false;
    if (member.handoffTimer) clearTimeout(member.handoffTimer);
    this.members.delete(member.playerId);
    this.memberByToken.delete(member.token);
    this.completeIfNoActiveMembers();
  }

  private async persistRunOutcome(member: Member, message: Extract<ServerMessage, { type: "runOver" }>, cargo: import("@dotbot/game/types").Item[]): Promise<RunManifest> {
    const unchanged: RunManifest = {
      reason: message.reason,
      keptItems: message.keptItems,
      lostItems: message.lostItems,
      learnedBlueprints: message.learnedBlueprints,
      cargo,
      contractCompletions: message.contractCompletions ?? [],
    };
    if (!this.matchId || !member.persistenceEligible) return unchanged;
    try {
      if (message.reason === "extracted") {
        const manifest: RunManifest = {
          reason: message.reason,
          keptItems: message.keptItems,
          lostItems: message.lostItems,
          learnedBlueprints: [],
          cargo,
          contractCompletions: [],
        };
        const result = await this.persistence.recordExtraction({
          matchId: this.matchId,
          playerId: member.playerId,
          manifest,
          blueprintLearningThreshold: this.config.blueprintLearningThreshold,
        });
        member.persistedOutcome = message.reason;
        return result.manifest;
      } else {
        await this.persistence.recordOutcome({ matchId: this.matchId, playerId: member.playerId, outcome: message.reason });
      }
      member.persistedOutcome = message.reason;
    } catch (error) {
      console.warn(`[persistence] failed to record ${message.reason} for ${member.playerId}; run continued. ${errorMessage(error)}`);
    }
    return unchanged;
  }

  private recordDisconnected(member: Member): void {
    if (!this.matchId || !member.persistenceEligible || member.persistedOutcome || member.runOver) return;
    member.persistenceEligible = false;
    this.matchOutcomes.set(member.playerId, "disconnected");
    const write = this.persistence.recordOutcome({
      matchId: this.matchId,
      playerId: member.playerId,
      outcome: "disconnected",
    }).then(() => {
      member.persistedOutcome = "disconnected";
    }).catch((error) => {
      console.warn(`[persistence] failed to record disconnect for ${member.playerId}; run continued. ${errorMessage(error)}`);
    });
    this.trackPersistence(write);
  }

  private trackPersistence(write: Promise<void>, after?: () => void): void {
    this.pendingPersistence.add(write);
    void write.finally(() => {
      this.pendingPersistence.delete(write);
      after?.();
    });
  }
}

function makeSpawn(
  id: string,
  name: string,
  squadId: string,
  color: string,
  insertion: InsertionPoint,
  offset: number,
  loadout: WireItemCode[],
  botRadius: number,
): BotSpawn {
  const defaultHealth = { kind: "powerup", type: "health" } as const;
  return {
    id,
    name,
    squadId,
    color,
    position: squadSpawnPosition(insertion, offset, botRadius),
    floorId: insertion.floorId,
    bays: loadout.length > 0
      ? Array.from({ length: 4 }, (_, index) => loadout[index] ? itemFromCode(loadout[index]) : null)
      : [defaultHealth, null, null, null],
    hold: [],
  };
}

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 24) || "Player";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function buildingIdForBot(floorId: string, position: { x: number; y: number }): string | null {
  return buildingOfFloor(downtownMap, floorId)?.id ?? buildingContaining(downtownMap, position)?.id ?? null;
}
