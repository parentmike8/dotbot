import { randomUUID } from "node:crypto";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { physicsFloorId } from "@dotbot/game/mapModel";
import { DotBotSimulation } from "@dotbot/game/simulation";
import type { BotSpawn, GameConfig, GameSnapshot, InputCommand, SimEvent } from "@dotbot/game/types";
import { filterEventsForViewer, filterForViewer, itemToCode, toEntityMeta, toWireEvent, toWireSnapshot } from "@dotbot/protocol";
import type { ClientMessage, LobbyMember, RoomPhase, ServerMessage } from "@dotbot/protocol";
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
};

const squads = ["alpha", "bravo", "crew-3"] as const;
const squadColors = ["#ff3b6b", "#2f80ed", "#9b51e0"] as const;
const squadAnchors = [
  { x: 300, y: 920 },
  { x: 1500, y: 800 },
  { x: 2210, y: 1320 },
] as const;

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

  constructor(code: string, options: RoomOptions = {}) {
    this.code = code;
    this.countdownMs = options.countdownMs ?? 3000;
    this.config = { ...defaultGameConfig, ...options.config };
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence ?? new NoopPersistence();
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

  join(peer: RoomPeer, token: string, requestedName: string, resolvedPlayerId?: string): Member | null {
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

    if (this.phase !== "lobby" || this.members.size >= squads.length * 4) {
      return null;
    }

    const index = this.members.size;
    const member: Member = {
      playerId: resolvedPlayerId ?? `p-${token.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "") || index}`,
      token,
      name: sanitizeName(requestedName),
      squadId: squads[index % squads.length],
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
        member.latestInput = { move: member.latestInput.move, dash: false };
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
    this.matchStartPromise = new Promise((resolve) => setTimeout(resolve, this.countdownMs)).then(() => this.startMatch());
  }

  private async startMatch(): Promise<void> {
    if (this.phase !== "countdown") return;
    const simulation = await DotBotSimulation.create({ map: downtownMap, config: this.config });
    for (const spawn of downtownMap.botSpawns) simulation.removeBot(spawn.id);

    const squadCounts = new Map<string, number>();
    for (const member of this.members.values()) {
      const squadIndex = squads.indexOf(member.squadId as (typeof squads)[number]);
      const count = squadCounts.get(member.squadId) ?? 0;
      const anchor = squadAnchors[squadIndex];
      const botId = `human-${member.playerId}`;
      simulation.spawnBot(makeSpawn(botId, member.name, member.squadId, squadColors[squadIndex], anchor, count), "human");
      member.botId = botId;
      member.inRun = true;
      member.streaming = true;
      member.runOver = null;
      member.persistenceEligible = true;
      member.persistedOutcome = null;
      squadCounts.set(member.squadId, count + 1);
    }

    for (const [squadId, count] of squadCounts) {
      if (count >= 2) continue;
      const squadIndex = squads.indexOf(squadId as (typeof squads)[number]);
      simulation.spawnBot(
        makeSpawn(`ai-${squadId}`, `${squadId} wing`, squadId, squadColors[squadIndex], squadAnchors[squadIndex], count),
        "ai",
      );
    }
    for (const spawn of downtownMap.botSpawns.filter((candidate) => candidate.isAmbient)) {
      simulation.spawnBot(spawn, "ai");
    }

    this.simulation = simulation;
    this.matchId = randomUUID();
    this.matchOutcomes.clear();
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
    });
  }

  private broadcastLobby(): void {
    this.broadcast({ type: "lobby", members: this.lobbyMembers, hostId: this.hostId });
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
    };
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
        : { type: "runOver", reason: "died", keptItems: [], lostItems: event.lostItems.map(itemToCode), learnedBlueprints: [] });
    }
  }

  private sendRunOver(member: Member, message: Extract<ServerMessage, { type: "runOver" }>): void {
    member.inRun = false;
    member.latestInput = { move: { x: 0, y: 0 }, dash: false };
    member.runOver = message;
    this.matchOutcomes.set(member.playerId, message.reason);
    const persistenceWrite = this.persistRunOutcome(member, message).then((learnedBlueprints) => {
      message.learnedBlueprints = learnedBlueprints;
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

  private async persistRunOutcome(member: Member, message: Extract<ServerMessage, { type: "runOver" }>): Promise<string[]> {
    if (!this.matchId || !member.persistenceEligible) return [];
    try {
      if (message.reason === "extracted") {
        const manifest: RunManifest = {
          reason: message.reason,
          keptItems: message.keptItems,
          lostItems: message.lostItems,
          learnedBlueprints: [],
        };
        const result = await this.persistence.recordExtraction({
          matchId: this.matchId,
          playerId: member.playerId,
          manifest,
          blueprintLearningThreshold: this.config.blueprintLearningThreshold,
        });
        member.persistedOutcome = message.reason;
        return result.learnedBlueprints;
      } else {
        await this.persistence.recordOutcome({ matchId: this.matchId, playerId: member.playerId, outcome: message.reason });
      }
      member.persistedOutcome = message.reason;
    } catch (error) {
      console.warn(`[persistence] failed to record ${message.reason} for ${member.playerId}; run continued. ${errorMessage(error)}`);
    }
    return [];
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

function makeSpawn(id: string, name: string, squadId: string, color: string, anchor: { x: number; y: number }, offset: number): BotSpawn {
  return {
    id,
    name,
    squadId,
    color,
    position: { x: anchor.x + (offset % 2) * 70, y: anchor.y + Math.floor(offset / 2) * 70 },
    bays: [{ kind: "powerup", type: "health" }, null, null, null],
    hold: [],
  };
}

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 24) || "Player";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
