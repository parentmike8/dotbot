import { createHash, randomUUID } from "node:crypto";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { buildingContaining, buildingOfFloor, physicsFloorId } from "@dotbot/game/mapModel";
import { DotBotSimulation } from "@dotbot/game/simulation";
import { assignSquadInsertions, squadSpawnPosition, validateInsertionMap } from "@dotbot/game/insertion";
import { isAmbientBotSpawn } from "@dotbot/game/faction";
import type { BotSpawn, GameConfig, GameSnapshot, InputCommand, InsertionPoint, SimEvent } from "@dotbot/game/types";
import { carriesAction, filterEventsForViewer, filterForViewer, itemFromCode, itemToCode, toEntityMeta, toViewerSnapshot, toWireEvent, toWireKillCamClip, toWireSnapshot, visiblePhysicsFloors } from "@dotbot/protocol";
import { LOBBY_SQUADS, PUBLIC_EXTRACTION_ROLE_COUNT, PUBLIC_EXTRACTION_SQUADS } from "@dotbot/protocol";
import type { ClientMessage, DeliveryClass, FullWireSnapshot, KillCamClip, LobbyMember, LobbySquadId, MatchIntel, PlayerRole, PublicArenaMember, PublicExtractionSquadId, RoomPhase, ServerMessage, ViewerContext, WireDot, WireDotContextSync, WireDotDelta, WireInputFrame } from "@dotbot/protocol";
import type { WireItemCode } from "@dotbot/protocol";
import { NoopPersistence, type Persistence, type RunManifest } from "./db";
import { KillCamHistory } from "./killCam";
import { assignPublicPlayerRoles, type PublicHuman } from "./hotArena";

export interface RoomPeer {
  readonly id: string;
  /** Async admission must not add a peer after its transport has closed. */
  isOpen?: () => boolean;
  /**
   * `encoded` is the exact JSON payload already measured by the room.
   *
   * Stream messages are bandwidth-accounted before they reach the transport.
   * Passing that encoding through avoids immediately serializing the same
   * snapshot a second time in the WebSocket adapter.
   */
  send(message: ServerMessage, delivery?: DeliveryClass, encoded?: string): void;
}

type Member = Omit<LobbyMember, "squadId"> & {
  squadId: LobbySquadId | PublicExtractionSquadId;
  /** Cloud SQL UUID. Never included in a client message or runtime entity id. */
  persistencePlayerId: string;
  token: string;
  peer: RoomPeer | null;
  botId: string | null;
  /** Seq-ordered frames not yet applied; exactly one is consumed per tick. */
  inputQueue: WireInputFrame[];
  /** Last applied input with its one-shot edges cleared; repeated on ticks
   * where the queue has underrun so held movement keeps flowing. */
  heldInput: InputCommand;
  /** Seq of the newest frame the simulation has actually consumed — the ack.
   * Reconciliation replays everything after it, so it must never report a
   * frame the sim has not integrated. */
  lastAppliedSeq: number;
  /** De-jitter latch: set on underrun, cleared once two frames are buffered
   * so paired 30Hz arrivals cannot ping-pong between starve and catch-up. */
  inputStarved: boolean;
  /** Ticks a lone frame has waited for its pair; bounded so sparse scripted
   * clients (single-frame messages) are never starved indefinitely. */
  starveHoldTicks: number;
  /** Adaptive jitter-buffer window: minimum queue depth seen this window and
   * ticks elapsed. Standing backlog (real input latency) keeps the minimum
   * high across a whole window; burst padding dips it back down. */
  backlogWindowMinDepth: number;
  backlogWindowTicks: number;
  /** Smoothed queue depth in ticks — the input latency this server itself
   * adds, folded into the member's combat rewind. */
  queueDepthEma: number;
  handoffTimer: ReturnType<typeof setTimeout> | null;
  disconnectedAt: number | null;
  inRun: boolean;
  streaming: boolean;
  /** Last viewer-filtered start envelope for this run. Retained through the
   * results phase so a refreshed NetSession can initialize map/config before
   * consuming the cached authoritative outcome after simulation disposal. */
  matchStart: Extract<ServerMessage, { type: "matchStart" }> | null;
  runOver: Extract<ServerMessage, { type: "runOver" }> | null;
  persistenceEligible: boolean;
  persistedOutcome: string | null;
  insertionName: string | null;
  dotContexts: Set<string>;
  dotState: Map<string, { active: boolean; captureProgressMs: number }>;
  /** Last private clip, retained only so a downed victim can resume after handoff. */
  lastKillCam: KillCamClip | null;
  /** Exact replay still owning this victim's input surface. */
  activeKillCamId: string | null;
  partyId: string;
  /** Trusted GameLift reservation identity. Kept internal so a canonical
   * account can still release a reservation issued to one of its retired
   * internal aliases without putting that UUID on the public protocol. */
  publicReservationPlayerId: string | null;
  queuedForNextRun: boolean;
};

export type RoomBandwidthHealth = {
  code: string;
  bytesPerSecond: number;
  members: number;
};

export type HotArenaOptions = {
  assemblyMinMs?: number;
  assemblyMaxMs?: number;
  maxRuns?: number;
  maxAgeMs?: number;
  minInsertionSpacing?: number;
};

export type PublicPartyAdmissionDecision =
  | { accepted: true }
  | { accepted: false; code: "party_composition_full" | "party_invalid" | "arena_capacity"; retryable: boolean };

type PublicJoinRejection = Exclude<PublicPartyAdmissionDecision, { accepted: true }>;

type PendingPersistenceSettlement = {
  matchId: string;
  settle: () => Promise<void>;
  failureMessage: string;
};

type PendingPersistenceOperation = {
  key: string;
  matchId: string;
  settle: () => Promise<void>;
};

class PublicStartRetiredError extends Error {}

export type PublicMemberRelease = {
  peerId: string | null;
  playerId: string;
  reservationPlayerId: string | null;
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
  /** Mobile network handoff grace. Production defaults to 20 seconds. */
  connectionHandoffMs?: number;
  /** Additive public quick-play lifecycle. Omit to retain legacy room/host behavior. */
  hotArena?: HotArenaOptions;
  onPublicAdmissionChange?: (state: { arenaId: string; open: boolean; closesAt?: number }) => void | Promise<void>;
  onPublicMemberReleased?: (release: PublicMemberRelease) => void | Promise<void>;
};

const squads = LOBBY_SQUADS;
const squadColors = ["#ff3b6b", "#2f80ed", "#9b51e0"] as const;
const publicSquadColors: Record<PublicExtractionSquadId, string> = {
  alpha: "#ff3b6b",
  bravo: "#2f80ed",
  charlie: "#9b51e0",
  delta: "#f2994a",
  echo: "#27ae60",
  foxtrot: "#56ccf2",
};
const defaultConnectionHandoffMs = 20_000;
const defaultHotArenaMinMs = 1_000;
const defaultHotArenaMaxMs = 6_000;
const defaultHotArenaMaxRuns = 20;
const defaultHotArenaMaxAgeMs = 2 * 60 * 60_000;
const defaultHotArenaMinInsertionSpacing = 350;
const persistenceSettlementRetryMs = 5_000;

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
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private endTick = Number.MAX_SAFE_INTEGER;
  private bandwidthWindowBytes = 0;
  private bandwidthWindowStartedAt: number;
  private lastBytesPerSecond = 0;
  private matchId: string | null = null;
  private readonly pendingPersistence = new Set<Promise<void>>();
  private persistenceSettled = true;
  private runPersistenceFailed = false;
  private endPromise: Promise<void> | null = null;
  private pendingPersistenceSettlement: PendingPersistenceSettlement | null = null;
  private readonly pendingPersistenceOperations = new Map<string, PendingPersistenceOperation>();
  private persistenceSettlementRetryAt = Number.POSITIVE_INFINITY;
  private persistenceSettlementRetryInFlight = false;
  private readonly matchOutcomes = new Map<string, string>();
  private readonly aiWingmates: boolean;
  private readonly matchIdFactory: () => string;
  private readonly connectionHandoffMs: number;
  private readonly matchIntel = new Map<string, MatchIntel>();
  private latestServerTick = 0;
  private killCamHistory = new KillCamHistory(downtownMap);
  private readonly hotArena: Required<HotArenaOptions> | null;
  private assemblyStartedAt: number | null = null;
  private assemblyDeadlineAt: number | null = null;
  private runCount = 0;
  private currentRoles: PlayerRole[] = [];
  private retiring = false;
  private publicAdmissionOpen = false;
  private publicAdmissionDeadline: number | null = null;
  private publicAdmissionFailed = false;
  private publicAdmissionLastAttemptAt = Number.NEGATIVE_INFINITY;
  private readonly onPublicAdmissionChange?: RoomOptions["onPublicAdmissionChange"];
  private readonly onPublicMemberReleased?: RoomOptions["onPublicMemberReleased"];
  private disposed = false;

  constructor(code: string, options: RoomOptions = {}) {
    this.code = code;
    this.countdownMs = options.countdownMs ?? 3000;
    this.config = { ...defaultGameConfig, ...options.config };
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence ?? new NoopPersistence();
    this.aiWingmates = options.aiWingmates ?? true;
    this.matchIdFactory = options.matchIdFactory ?? randomUUID;
    this.connectionHandoffMs = options.connectionHandoffMs ?? defaultConnectionHandoffMs;
    this.hotArena = options.hotArena ? normalizeHotArenaOptions(options.hotArena) : null;
    this.onPublicAdmissionChange = options.onPublicAdmissionChange;
    this.onPublicMemberReleased = options.onPublicMemberReleased;
    if (this.hotArena) this.phase = "assembling";
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
    return [...this.members.values()].map(({ playerId, name, squadId }) => ({ playerId, name, squadId: squadId as LobbySquadId }));
  }

  get retirementRequested(): boolean {
    return this.retiring;
  }

  get publicArenaMembers(): PublicArenaMember[] {
    return [...this.members.values()].map(({ playerId, name, partyId, queuedForNextRun }) => ({
      playerId,
      name,
      partyId,
      queued: queuedForNextRun,
    }));
  }

  get bandwidthHealth(): RoomBandwidthHealth {
    const elapsedSeconds = Math.max(0.001, (this.now() - this.bandwidthWindowStartedAt) / 1000);
    return {
      code: this.code,
      bytesPerSecond: Math.round(this.bandwidthWindowBytes > 0 ? this.bandwidthWindowBytes / elapsedSeconds : this.lastBytesPerSecond),
      members: this.members.size,
    };
  }

  get safeToTerminate(): boolean {
    if (this.hotArena) return (this.phase === "assembling" || this.phase === "results") && this.persistenceSettled;
    return this.phase === "lobby" || (this.phase === "ended" && this.persistenceSettled);
  }

  get readyForDisposal(): boolean {
    if (this.hotArena) return this.retiring && this.safeToTerminate;
    return this.phase === "ended" && this.persistenceSettled;
  }

  requestRetirement(): void {
    if (this.disposed || !this.hotArena || this.retiring) return;
    this.retiring = true;
    this.publishPublicAdmission(false);
    if ((this.phase === "assembling" || this.phase === "countdown") && !this.matchStartPromise) {
      this.phase = "assembling";
      this.assemblyStartedAt = null;
      this.assemblyDeadlineAt = null;
    }
    this.broadcastLobby();
  }

  async waitForPersistence(): Promise<void> {
    if (this.endPromise) await this.endPromise;
    else await Promise.allSettled([...this.pendingPersistence]);
  }

  evaluatePublicPartyAdmission(party: readonly PublicHuman[]): PublicPartyAdmissionDecision {
    if (!this.hotArena || this.retiring || this.matchStartPromise
      || (this.phase !== "assembling" && this.phase !== "countdown" && this.phase !== "results")) {
      return { accepted: false, code: "arena_capacity", retryable: true };
    }
    if (party.length < 1 || party.length > 3 || new Set(party.map((member) => member.partyId)).size !== 1
      || new Set(party.map((member) => member.playerId)).size !== party.length
      || party.some((member) => this.members.has(member.playerId))) {
      return { accepted: false, code: "party_invalid", retryable: false };
    }
    if (this.members.size + party.length > PUBLIC_EXTRACTION_ROLE_COUNT) return { accepted: false, code: "party_composition_full", retryable: true };
    try {
      assignPublicPlayerRoles([
        ...[...this.members.values()].map((member) => ({ playerId: member.playerId, name: member.name, partyId: member.partyId })),
        ...party,
      ], "admission");
      return { accepted: true };
    } catch {
      return { accepted: false, code: "party_composition_full", retryable: true };
    }
  }

  join(
    peer: RoomPeer,
    token: string,
    requestedName: string,
    resolvedPlayerId?: string,
    preferredSquad?: LobbySquadId,
    partyId?: string,
    onPublicRejected?: (rejection: PublicJoinRejection) => void,
    publicReservationPlayerId?: string,
    persistencePlayerId = resolvedPlayerId,
    previousPlayerIds: string[] = [],
    previousPersistencePlayerIds: string[] = [],
  ): Member | null {
    if (this.disposed) return null;
    const existing = this.memberByToken.get(token);
    if (existing) {
      if (resolvedPlayerId && existing.playerId !== resolvedPlayerId && !previousPlayerIds.includes(existing.playerId)) {
        onPublicRejected?.({ accepted: false, code: "party_invalid", retryable: false });
        return null;
      }
      if (persistencePlayerId && existing.persistencePlayerId !== persistencePlayerId
        && !previousPersistencePlayerIds.includes(existing.persistencePlayerId)) {
        onPublicRejected?.({ accepted: false, code: "party_invalid", retryable: false });
        return null;
      }
      if (publicReservationPlayerId && existing.publicReservationPlayerId
        && existing.publicReservationPlayerId !== publicReservationPlayerId) return null;
      if (existing.peer && existing.peer.id !== peer.id) return null;
      existing.peer = peer;
      if (persistencePlayerId) existing.persistencePlayerId = persistencePlayerId;
      existing.name = sanitizeName(requestedName);
      existing.streaming = true;
      existing.disconnectedAt = null;
      existing.inputQueue = [];
      existing.heldInput = { move: { x: 0, y: 0 }, dash: false };
      // A full page refresh creates a new NetSession whose input sequence
      // starts at 1. Keeping the old acknowledgement would make every command
      // from the refreshed page look stale until it counted all the way back
      // up, leaving the reconnected bot effectively immovable.
      existing.lastAppliedSeq = 0;
      existing.inputStarved = true;
      existing.starveHoldTicks = 0;
      existing.backlogWindowMinDepth = Number.POSITIVE_INFINITY;
      existing.backlogWindowTicks = 0;
      existing.queueDepthEma = 0;
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
      } else if (this.phase === "results") {
        // Replay the run baseline before the cached outcome so both a reused
        // NetSession and a full-page refresh can initialize and scrub private
        // transport state. While settlement still owns the simulation, refresh
        // the envelope from current authority; afterward use the retained
        // viewer-filtered start envelope from this exact run.
        if (this.simulation && existing.botId) this.sendMatchStart(existing);
        else {
          if (existing.matchStart) existing.peer?.send(existing.matchStart);
          if (existing.runOver) existing.peer?.send(existing.runOver);
        }
      }
      return existing;
    }

    const admittedPlayerIds = new Set([resolvedPlayerId, ...previousPlayerIds].filter((value): value is string => Boolean(value)));
    const admittedPersistencePlayerIds = new Set(
      [persistencePlayerId, ...previousPersistencePlayerIds].filter((value): value is string => Boolean(value)),
    );
    if ([...this.members.values()].some((member) => admittedPlayerIds.has(member.playerId)
      || admittedPersistencePlayerIds.has(member.persistencePlayerId))) {
      onPublicRejected?.({ accepted: false, code: "party_invalid", retryable: false });
      return null;
    }

    const publicAdmissionOpen = this.hotArena && !this.matchStartPromise
      && (this.phase === "assembling" || this.phase === "countdown" || this.phase === "results") && !this.retiring;
    if ((!this.hotArena && this.phase !== "lobby") || (this.hotArena && !publicAdmissionOpen) || this.members.size >= (this.hotArena ? PUBLIC_EXTRACTION_ROLE_COUNT : squads.length * 3)) {
      if (this.hotArena) onPublicRejected?.({ accepted: false, code: "arena_capacity", retryable: true });
      return null;
    }

    const fallbackPlayerId = `p-${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
    const member: Member = {
      playerId: resolvedPlayerId ?? fallbackPlayerId,
      persistencePlayerId: persistencePlayerId ?? resolvedPlayerId ?? fallbackPlayerId,
      token,
      name: sanitizeName(requestedName),
      squadId: this.hotArena ? "alpha" : this.availableSquad(preferredSquad),
      peer,
      botId: null,
      inputQueue: [],
      heldInput: { move: { x: 0, y: 0 }, dash: false },
      lastAppliedSeq: 0,
      inputStarved: true,
      starveHoldTicks: 0,
      backlogWindowMinDepth: Number.POSITIVE_INFINITY,
      backlogWindowTicks: 0,
      queueDepthEma: 0,
      handoffTimer: null,
      disconnectedAt: null,
      inRun: false,
      streaming: true,
      matchStart: null,
      runOver: null,
      persistenceEligible: true,
      persistedOutcome: null,
      insertionName: null,
      dotContexts: new Set(),
      dotState: new Map(),
      lastKillCam: null,
      activeKillCamId: null,
      partyId: this.hotArena ? sanitizePartyId(partyId, resolvedPlayerId ?? token) : `legacy-${resolvedPlayerId ?? token}`,
      publicReservationPlayerId: this.hotArena ? publicReservationPlayerId ?? null : null,
      queuedForNextRun: true,
    };
    if (this.hotArena) {
      if ([...this.members.values()].filter((candidate) => candidate.partyId === member.partyId).length >= 3) {
        this.releasePublicParty(
          member.partyId,
          "party_invalid",
          "A public quick-play party cannot exceed three players. Re-enter quick play with a valid party.",
          false,
        );
        onPublicRejected?.({ accepted: false, code: "party_invalid", retryable: false });
        return null;
      }
      try {
        assignPublicPlayerRoles([...this.members.values(), member].map((candidate) => ({
          playerId: candidate.playerId,
          name: candidate.name,
          partyId: candidate.partyId,
        })), "admission");
      } catch {
        this.releasePublicParty(member.partyId);
        onPublicRejected?.({ accepted: false, code: "party_composition_full", retryable: true });
        return null;
      }
    }
    this.members.set(member.playerId, member);
    this.memberByToken.set(token, member);
    if (!this.hotArena && !this.hostId) {
      this.hostId = member.playerId;
    }
    this.sendWelcome(member);
    this.broadcastLobby();
    if (this.hotArena) this.beginPublicAssemblyIfNeeded();
    return member;
  }

  receive(
    playerId: string,
    message: Exclude<ClientMessage, { type: "hello" | "quickPlayHello" | "baseHello" | "baseInput" }>,
  ): void {
    const member = this.members.get(playerId);
    if (!member) return;

    switch (message.type) {
      case "startMatch":
        if (this.hotArena) {
          member.peer?.send({ type: "err", code: "automatic_start", msg: "Public quick play starts automatically." });
          return;
        }
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
        if (this.hotArena) {
          member.peer?.send({ type: "err", code: "automatic_squads", msg: "Public quick play keeps parties together automatically." });
          return;
        }
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
      case "deployAgain":
        if (!this.hotArena || this.phase !== "results") {
          member.peer?.send({ type: "err", code: "bad_phase", msg: "Deploy again is available after a public run." });
          return;
        }
        if (this.retiring) {
          member.peer?.send({ type: "err", code: "arena_retiring", msg: "This arena is retiring. Quick play will place the next deployment elsewhere." });
          return;
        }
        this.queueParty(member.partyId);
        if (this.persistenceSettled) this.enterPublicAssembly();
        else this.broadcastLobby();
        return;
      case "leaveRun":
        this.leaveRun(member);
        return;
      case "killCamDone":
        if (member.activeKillCamId === message.clipId) member.activeKillCamId = null;
        return;
      case "input": {
        if (this.phase !== "live" || !member.inRun) return;
        const frames: WireInputFrame[] = message.frames ?? [{
          seq: message.seq,
          move: message.move,
          dash: message.dash,
          viewTick: message.viewTick,
          useBay: message.useBay,
          swapBay: message.swapBay,
          drop: message.drop,
          downedVerb: message.downedVerb,
          take: message.take,
          plea: message.plea,
          ping: message.ping,
        }];
        this.enqueueInputFrames(member, frames);
        return;
      }
      case "ping":
        if (typeof message.viewDelayMs === "number" && member.botId && this.simulation) {
          // Client reports what it sees (render delay + round trip); the
          // queue wait is latency this server adds, so it joins the rewind.
          const clampedMs = Math.max(0, Math.min(300, message.viewDelayMs));
          this.simulation.setViewDelayTicks(member.botId, clampedMs / this.tickDurationMs + member.queueDepthEma);
        }
        member.peer?.send({ type: "pong", cts: message.cts, sts: this.now(), tick: this.latestServerTick });
        return;
    }
  }

  disconnect(peerId: string): void {
    const member = [...this.members.values()].find((candidate) => candidate.peer?.id === peerId);
    if (!member) return;
    member.peer = null;
    member.disconnectedAt = this.now();

    if (this.phase === "lobby" || (this.hotArena && (this.phase === "assembling" || this.phase === "results"))) {
      this.scheduleHandoff(member);
      this.broadcastLobby();
      return;
    }

    if (this.hotArena && this.phase === "countdown") {
      this.scheduleHandoff(member);
      this.broadcastLobby();
      return;
    }

    if (this.phase === "live" && member.botId && member.inRun) {
      this.simulation?.setController(member.botId, "frozen");
      this.scheduleHandoff(member);
    }
  }

  private scheduleHandoff(member: Member): void {
    if (member.handoffTimer) clearTimeout(member.handoffTimer);
    const disconnectedAt = member.disconnectedAt ?? this.now();
    member.disconnectedAt = disconnectedAt;
    const remainingMs = Math.max(0, this.connectionHandoffMs - (this.now() - disconnectedAt));
    member.handoffTimer = setTimeout(() => this.expireHandoff(member), remainingMs);
  }

  private expireHandoff(member: Member): void {
    member.handoffTimer = null;
    if (member.peer) return;
    if (this.hotArena && this.phase === "countdown" && this.matchStartPromise) {
      // The run roster is already frozen. Keep this role in that roster and
      // let startMatch promote it to run-long AI; deleting it here would leave
      // a spawned, persistence-registered ghost with no owning member.
      this.memberByToken.delete(member.token);
      this.broadcastLobby();
      return;
    }
    if (this.phase === "lobby" || (this.hotArena && (this.phase === "assembling" || this.phase === "countdown" || this.phase === "results"))) {
      this.members.delete(member.playerId);
      this.memberByToken.delete(member.token);
      if (member.playerId === this.hostId) this.hostId = this.members.keys().next().value ?? "";
      if (this.hotArena && this.readyMembers().length === 0) this.resetPublicAssembly();
      this.broadcastLobby();
      return;
    }
    if (this.phase !== "live" || !member.botId || !member.inRun) return;
    this.memberByToken.delete(member.token);
    this.simulation?.setController(member.botId, "ai");
    if (this.hotArena && this.matchId) {
      const role = this.currentRoles.find((candidate) => candidate.playerId === member.playerId);
      if (role) {
        role.controller = "ai";
        this.broadcast({
          type: "roleController",
          matchId: this.matchId,
          roleId: role.roleId,
          controller: "ai",
          reason: "disconnect_timeout",
        });
      }
    }
    this.recordDisconnected(member);
    const allHandoffsExpired = [...this.members.values()].every((candidate) => candidate.peer || candidate.handoffTimer === null);
    if (!this.hotArena && this.connectedCount === 0 && allHandoffsExpired) this.end("all_humans_disconnected");
  }

  tick(now = this.now()): number[] {
    if (this.disposed) return [];
    this.rollBandwidthWindow(now);
    this.retryPersistenceSettlement(now);
    if (this.hotArena) {
      if (this.publicAdmissionFailed && now - this.publicAdmissionLastAttemptAt >= 500) {
        this.publishPublicAdmission(this.publicAdmissionOpen, this.publicAdmissionDeadline ?? undefined);
      }
      if (!this.retiring && now - this.createdAt >= this.hotArena.maxAgeMs) {
        this.requestRetirement();
      }
      if (this.phase === "assembling" || this.phase === "countdown") {
        this.tickPublicAssembly(now);
        this.lastTickAt = now;
        return [];
      }
    }
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
        this.simulation.applyInput(member.botId, this.consumeInputFrame(member));
      }
      this.simulation.step();
      durations.push(performance.now() - started);
      this.accumulatorMs -= this.tickDurationMs;
      steps += 1;

      const snapshot = this.simulation.getSnapshot();
      this.latestServerTick = snapshot.debug.tickCount;
      const events = this.simulation.drainEvents();
      this.killCamHistory.recordEvents(events);
      this.syncMemberSquads(snapshot);
      if (snapshot.debug.tickCount % 3 === 0 || events.some((event) => event.type === "downed")) {
        this.killCamHistory.record(snapshot);
      }
      this.processKillCamEvents(events, snapshot);
      this.processRunEvents(events);
      if (events.length > 0) this.broadcastEvents(events, snapshot);

      if (snapshot.debug.tickCount % 3 === 0) {
        this.broadcastSnapshot(snapshot);
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
    if (this.disposed) return;
    this.disposed = true;
    this.publishPublicAdmission(false);
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    this.matchStartPromise = null;
    for (const member of this.members.values()) {
      if (member.handoffTimer) clearTimeout(member.handoffTimer);
    }
    this.simulation?.dispose();
    this.simulation = null;
  }

  /** Insert frames in seq order, dropping duplicates (redundant copies ride
   * along in every message) and anything the simulation already consumed. */
  private enqueueInputFrames(member: Member, frames: readonly WireInputFrame[]): void {
    for (const frame of frames) {
      if (frame.seq <= member.lastAppliedSeq) continue;
      if (member.inputQueue.some((queued) => queued.seq === frame.seq)) continue;
      const insertAt = member.inputQueue.findIndex((queued) => queued.seq > frame.seq);
      if (insertAt === -1) member.inputQueue.push(frame);
      else member.inputQueue.splice(insertAt, 0, frame);
    }
    // A transport stall delivers its backlog as one burst; anything beyond a
    // couple of ticks of buffered input would become standing input latency,
    // so shed the oldest frames and let client reconciliation absorb the gap.
    while (member.inputQueue.length > 6) {
      // Preserve real actions when shedding stale continuous movement. A
      // redundant datagram burst must never discard the only dash/bay/plea
      // edge merely because it was older than newer movement samples.
      const droppable = member.inputQueue.findIndex((queued) => !carriesAction(queued));
      const dropAt = droppable === -1 ? 0 : droppable;
      const dropped = member.inputQueue.splice(dropAt, 1)[0];
      if (dropAt === 0 && dropped) member.lastAppliedSeq = dropped.seq;
    }
  }

  /**
   * Exactly one input frame is consumed per simulation tick — the invariant
   * client prediction replays against. On underrun the last applied movement
   * repeats with its one-shot edges (dash, bay use, plea) cleared.
   */
  private consumeInputFrame(member: Member): InputCommand {
    this.trimStandingBacklog(member);
    if (member.inputStarved && member.inputQueue.length === 1 && member.starveHoldTicks < 2) {
      member.starveHoldTicks += 1;
      return member.heldInput;
    }
    const frame = member.inputQueue.shift();
    if (!frame) {
      member.inputStarved = true;
      member.starveHoldTicks = 0;
      return member.heldInput;
    }
    member.inputStarved = false;
    member.starveHoldTicks = 0;
    member.lastAppliedSeq = frame.seq;
    if (frame.dash && frame.viewTick !== undefined && Number.isFinite(frame.viewTick) && member.botId && this.simulation) {
      // The frame carries the actual remote-world tick visible when the dash
      // was pressed. Queueing and uplink delay are therefore included once,
      // without periodically guessing from a full RTT.
      const attackTick = this.latestServerTick + 1;
      this.simulation.setViewDelayTicks(member.botId, Math.max(0, attackTick - frame.viewTick));
    }
    const input: InputCommand = {
      move: { x: frame.move[0], y: frame.move[1] },
      dash: frame.dash,
      useBay: frame.useBay,
      swapBay: frame.swapBay,
      drop: frame.drop,
      downedVerb: frame.downedVerb,
      take: frame.take,
      plea: frame.plea,
      ping: frame.ping ? {
        kind: frame.ping.kind,
        position: { x: frame.ping.position[0], y: frame.ping.position[1] },
        floorId: frame.ping.floorId,
      } : undefined,
    };
    const applied = member.activeKillCamId
      ? {
          move: { x: 0, y: 0 },
          dash: false,
          ...(input.plea ? { plea: true } : {}),
        }
      : input;
    member.heldInput = {
      move: applied.move,
      dash: false,
      downedVerb: applied.downedVerb,
      plea: false,
    };
    return applied;
  }

  /**
   * Adaptive jitter-buffer trim. Burst padding comes and goes within a
   * window; standing backlog — permanent input latency left behind by a
   * transport stall — keeps even the window's MINIMUM depth above the
   * de-jitter target. Only that surplus is trimmed (once a second, edge-free
   * frames first), so ordinary burst absorption never costs a correction.
   */
  private trimStandingBacklog(member: Member): void {
    member.queueDepthEma += (member.inputQueue.length - member.queueDepthEma) * 0.05;
    member.backlogWindowMinDepth = Math.min(member.backlogWindowMinDepth, member.inputQueue.length);
    member.backlogWindowTicks += 1;
    if (member.backlogWindowTicks < 60) {
      return;
    }
    const surplus = Math.min(member.backlogWindowMinDepth, member.inputQueue.length) - 2;
    member.backlogWindowTicks = 0;
    member.backlogWindowMinDepth = Number.POSITIVE_INFINITY;
    for (let index = 0; index < surplus; index += 1) {
      const candidate = member.inputQueue.findIndex((queued) => !carriesAction(queued));
      const dropAt = candidate === -1 ? 0 : candidate;
      const dropped = member.inputQueue.splice(dropAt, 1)[0];
      if (!dropped) {
        break;
      }
      if (dropAt === 0) {
        member.lastAppliedSeq = Math.max(member.lastAppliedSeq, dropped.seq);
      }
    }
  }

  private readyMembers(): Member[] {
    return [...this.members.values()].filter((member) => member.queuedForNextRun && (member.peer !== null || member.handoffTimer !== null));
  }

  private queueParty(partyId: string): void {
    for (const candidate of this.members.values()) {
      if (candidate.partyId === partyId && (candidate.peer || candidate.handoffTimer)) candidate.queuedForNextRun = true;
    }
  }

  private beginPublicAssemblyIfNeeded(): void {
    if (!this.hotArena || this.phase !== "assembling" || !this.persistenceSettled || this.retiring || this.readyMembers().length === 0 || this.assemblyStartedAt !== null) return;
    this.assemblyStartedAt = this.now();
    this.assemblyDeadlineAt = this.assemblyStartedAt + this.hotArena.assemblyMaxMs;
    this.phase = "assembling";
    this.publishPublicAdmission(true, this.assemblyDeadlineAt);
    this.broadcastLobby();
  }

  private enterPublicAssembly(): void {
    if (!this.hotArena || this.retiring) return;
    this.releaseUnqueuedMembers();
    this.phase = "assembling";
    this.assemblyStartedAt = null;
    this.assemblyDeadlineAt = null;
    this.beginPublicAssemblyIfNeeded();
  }

  private releaseUnqueuedMembers(): void {
    for (const member of [...this.members.values()]) {
      if (member.queuedForNextRun) continue;
      this.releasePublicMember(member, "redeploy_not_selected", "This party did not opt into the next run. Re-enter quick play to deploy.");
    }
  }

  private releasePublicParty(
    partyId: string,
    code = "party_composition_full",
    msg = "This party no longer fits in this assembly. Re-enter quick play together.",
    retryable = true,
  ): void {
    for (const member of [...this.members.values()]) {
      if (member.partyId !== partyId) continue;
      this.releasePublicMember(member, code, msg, retryable);
    }
    if (this.readyMembers().length === 0) this.resetPublicAssembly();
    this.broadcastLobby();
  }

  private releasePublicMember(member: Member, code: string, msg: string, retryable = false): void {
    if (member.handoffTimer) clearTimeout(member.handoffTimer);
    this.members.delete(member.playerId);
    this.memberByToken.delete(member.token);
    const peer = member.peer;
    member.peer = null;
    member.streaming = false;
    peer?.send({ type: "err", code, msg, ...(retryable ? { retryable: true } : {}) });
    this.notifyPublicMemberReleased(peer?.id ?? null, member);
  }

  private notifyPublicMemberReleased(peerId: string | null, member: Member): void {
    void (async () => this.onPublicMemberReleased?.({
      peerId,
      playerId: member.playerId,
      reservationPlayerId: member.publicReservationPlayerId,
    }))().catch((error) => {
      console.error(`[arena ${this.code}] failed to release player ${member.playerId}. ${safeErrorName(error)}`);
    });
  }

  private resetPublicAssembly(): void {
    if (!this.hotArena) return;
    this.phase = "assembling";
    this.assemblyStartedAt = null;
    this.assemblyDeadlineAt = null;
    this.publishPublicAdmission(false);
  }

  private publishPublicAdmission(open: boolean, closesAt?: number): void {
    const deadline = open ? closesAt ?? null : null;
    if (!this.hotArena) return;
    const now = this.now();
    const sameState = this.publicAdmissionOpen === open && this.publicAdmissionDeadline === deadline;
    if (sameState && (!this.publicAdmissionFailed || now - this.publicAdmissionLastAttemptAt < 500)) return;
    this.publicAdmissionOpen = open;
    this.publicAdmissionDeadline = deadline;
    this.publicAdmissionFailed = false;
    this.publicAdmissionLastAttemptAt = now;
    void (async () => this.onPublicAdmissionChange?.({
      arenaId: this.code,
      open,
      ...(deadline === null ? {} : { closesAt: deadline }),
    }))().catch((error) => {
      if (this.publicAdmissionOpen === open && this.publicAdmissionDeadline === deadline) this.publicAdmissionFailed = true;
      console.error(`[arena ${this.code}] failed to publish admission=${open}. ${safeErrorName(error)}`);
    });
  }

  private tickPublicAssembly(now: number): void {
    if (!this.hotArena || this.matchStartPromise || this.retiring) return;
    if (this.readyMembers().length === 0) {
      if (this.assemblyStartedAt !== null) {
        this.resetPublicAssembly();
        this.broadcastLobby();
      }
      return;
    }
    if (this.assemblyStartedAt === null || this.assemblyDeadlineAt === null) {
      this.assemblyStartedAt = now;
      this.assemblyDeadlineAt = now + this.hotArena.assemblyMaxMs;
      this.broadcastLobby();
      return;
    }
    const minimumReached = now - this.assemblyStartedAt >= this.hotArena.assemblyMinMs;
    if (!minimumReached) return;
    if (this.phase === "assembling") {
      this.phase = "countdown";
      this.broadcastLobby();
    }
    const humanCapacityReached = this.readyMembers().length === PUBLIC_EXTRACTION_ROLE_COUNT;
    if (!humanCapacityReached && now < this.assemblyDeadlineAt) return;
    this.publishPublicAdmission(false);
    this.matchStartPromise = this.startMatch()
      .catch((error) => this.failPublicStart(error))
      .finally(() => {
        this.matchStartPromise = null;
      });
  }

  private async failPublicStart(error: unknown): Promise<void> {
    const retirementInterruptedStart = error instanceof PublicStartRetiredError;
    console.error(`[arena ${this.code}] public run ${retirementInterruptedStart ? "was interrupted by retirement" : "failed before live"}; retiring arena. ${safeErrorName(error)}`);
    const failedMatchId = this.matchId;
    const failedMembers = this.currentRoles.flatMap((role) => {
      if (!role.playerId) return [];
      const member = this.members.get(role.playerId);
      return member?.persistenceEligible ? [member] : [];
    });
    const endedAt = this.now();
    this.simulation?.dispose();
    this.simulation = null;
    this.matchId = null;
    this.currentRoles = [];
    this.persistenceSettled = failedMatchId === null;
    this.phase = "assembling";
    this.retiring = true;
    this.publishPublicAdmission(false);
    this.broadcast(retirementInterruptedStart
      ? { type: "err", code: "arena_retiring", msg: "This arena is retiring. Quick play will place the next deployment elsewhere." }
      : { type: "err", code: "arena_configuration_invalid", msg: "This arena could not start safely. Re-enter quick play." });
    this.broadcastLobby();
    if (!failedMatchId) return;
    const outcomeInputs = failedMembers.map((member) => {
      this.matchOutcomes.set(member.playerId, "disconnected");
      return {
        matchId: failedMatchId,
        playerId: member.persistencePlayerId,
        outcome: "disconnected" as const,
      };
    });
    const finishInput = {
      matchId: failedMatchId,
      endedAt: new Date(endedAt),
      summary: {
        reason: retirementInterruptedStart ? "retirement_before_live" : "configuration_failure",
        participantCount: failedMembers.length,
        outcomes: failedMembers.length > 0 ? { disconnected: failedMembers.length } : {},
      },
    };
    const recovery = this.settlePersistenceBoundary({
      matchId: failedMatchId,
      settle: async () => {
        await Promise.all(outcomeInputs.map((input) => this.persistence.recordOutcome(input)));
        await this.persistence.finishMatch(finishInput);
      },
      failureMessage: `[persistence] failed to settle aborted match ${failedMatchId}; arena remains unsafe to terminate.`,
    }).then(() => undefined);
    this.endPromise = recovery;
    await recovery;
  }

  private beginCountdown(): void {
    this.phase = "countdown";
    this.broadcastLobby();
    this.matchStartPromise = new Promise<void>((resolve) => {
      this.countdownTimer = setTimeout(() => {
        this.countdownTimer = null;
        resolve();
      }, this.countdownMs);
    }).then(() => this.startMatch()).finally(() => {
      this.matchStartPromise = null;
    });
  }

  private async startMatch(): Promise<void> {
    if (this.disposed || this.phase !== "countdown") return;
    if (this.hotArena && this.retiring) return;
    const runMembers = this.hotArena ? this.readyMembers() : [...this.members.values()];
    if (runMembers.length === 0) {
      if (this.hotArena) this.resetPublicAssembly();
      else this.phase = "lobby";
      return;
    }
    const simulation = await DotBotSimulation.create({ map: downtownMap, config: this.config });
    if (this.disposed) {
      simulation.dispose();
      return;
    }
    if (this.hotArena && this.retiring) {
      simulation.dispose();
      this.phase = "assembling";
      this.assemblyStartedAt = null;
      this.assemblyDeadlineAt = null;
      return;
    }
    this.killCamHistory = new KillCamHistory(downtownMap);
    this.simulation = simulation;
    for (const spawn of downtownMap.botSpawns) simulation.removeBot(spawn.id);

    const runSquads = this.hotArena ? PUBLIC_EXTRACTION_SQUADS : squads;
    validateInsertionMap(downtownMap, runSquads.length, this.config.botRadius, this.hotArena ? 0 : 2);
    const assignmentSeed = this.matchIdFactory();
    this.matchId = assignmentSeed;
    this.endPromise = null;
    this.persistenceSettled = true;
    this.runPersistenceFailed = false;
    this.currentRoles = this.hotArena ? assignPublicPlayerRoles(runMembers.map((member) => ({
      playerId: member.playerId,
      name: member.name,
      partyId: member.partyId,
    })), assignmentSeed) : [];
    if (this.hotArena) {
      for (const role of this.currentRoles) {
        if (role.controller !== "human" || !role.playerId) continue;
        const member = this.members.get(role.playerId);
        if (member) {
          member.squadId = role.squadId;
          if (!member.peer && !member.handoffTimer) role.controller = "ai";
        }
      }
    }
    this.matchOutcomes.clear();
    this.matchIntel.clear();
    let loadouts = new Map<string, WireItemCode[]>();
    try {
      const started = await this.persistence.startMatch({
        matchId: this.matchId,
        roomCode: this.code,
        mapId: downtownMap.id,
        startedAt: new Date(this.now()),
        playerIds: runMembers.filter((member) => member.persistenceEligible).map((member) => member.persistencePlayerId),
      });
      loadouts = new Map(Object.entries(started.loadouts));
    } catch (error) {
      if (this.disposed) {
        simulation.dispose();
        this.simulation = null;
        return;
      }
      console.warn(`[persistence] failed to start match ${this.matchId}. ${safeErrorName(error)}`);
      if (this.persistence.live) {
        simulation.dispose();
        this.simulation = null;
        if (this.hotArena) {
          // A timed-out relay may have committed startMatch even when every
          // response was lost. Retire and attempt to close this exact match id
          // rather than reopening assembly and risking a second loadout debit.
          throw error;
        }
        this.matchId = null;
        this.phase = "lobby";
        this.broadcast({ type: "err", code: "storage_unavailable", msg: "The match could not start safely. Your loadout was not consumed; try again." });
        this.broadcastLobby();
        for (const member of runMembers) {
          if (!member.peer && !member.handoffTimer) this.scheduleHandoff(member);
        }
        return;
      }
    }
    if (this.disposed) {
      simulation.dispose();
      this.simulation = null;
      return;
    }
    if (this.hotArena && this.retiring) throw new PublicStartRetiredError("Arena retirement began during match start.");

    const insertionPreferences = new Map<string, string | null>();
    const intelObjects = new Map<string, import("@dotbot/game/types").BaseObjectKind[]>();
    for (const member of runMembers) {
      try {
        insertionPreferences.set(member.playerId, await this.persistence.getInsertionPreference(member.persistencePlayerId));
      } catch {
        insertionPreferences.set(member.playerId, null);
        console.warn(`[persistence] failed to read insertion preference for ${member.playerId}; assigning without it.`);
      }
      try {
        intelObjects.set(member.playerId, await this.persistence.getMatchIntelObjects(member.persistencePlayerId));
      } catch {
        intelObjects.set(member.playerId, []);
        console.warn(`[persistence] failed to read match intel furniture for ${member.playerId}; omitting intel.`);
      }
      if (this.disposed) {
        simulation.dispose();
        this.simulation = null;
        return;
      }
      if (this.hotArena && this.retiring) throw new PublicStartRetiredError("Arena retirement began during match start.");
    }

    const activeSquads = this.hotArena
      ? [...PUBLIC_EXTRACTION_SQUADS]
      : squads.filter((squadId) => runMembers.some((member) => member.squadId === squadId));
    const insertionAssignments = assignSquadInsertions({
      squads: activeSquads.map((squadId) => ({
        squadId,
        members: runMembers
          .filter((member) => member.squadId === squadId)
          .map((member) => ({ playerId: member.playerId, preference: insertionPreferences.get(member.playerId) ?? null })),
      })),
      points: downtownMap.insertionPoints,
      matchId: assignmentSeed,
      minSpacing: this.hotArena?.minInsertionSpacing ?? this.config.minInsertionSpacing,
    });
    const insertionBySquad = new Map(insertionAssignments.map((assignment) => [assignment.squadId, assignment.point]));

    const squadCounts = new Map<string, number>();
    const expiredTakeovers: Member[] = [];
    const roleByPlayerId = new Map(this.currentRoles.flatMap((role) => role.playerId ? [[role.playerId, role] as const] : []));
    for (const member of runMembers) {
      const squadIndex = squads.indexOf(member.squadId as (typeof squads)[number]);
      const count = squadCounts.get(member.squadId) ?? 0;
      const slot = this.hotArena ? roleByPlayerId.get(member.playerId)?.slot ?? count : count;
      const insertion = insertionBySquad.get(member.squadId)!;
      const botId = `human-${member.playerId}`;
      const controller = member.peer ? "human" : member.handoffTimer ? "frozen" : "ai";
      if (this.hotArena && controller === "ai") {
        const role = roleByPlayerId.get(member.playerId);
        if (role) role.controller = "ai";
      }
      simulation.spawnBot(
        makeSpawn(botId, member.name, member.squadId, this.hotArena ? publicSquadColors[member.squadId as PublicExtractionSquadId] : squadColors[squadIndex], insertion, slot, loadouts.get(member.persistencePlayerId) ?? [], this.config.botRadius),
        controller,
      );
      member.botId = botId;
      member.inputQueue = [];
      member.heldInput = { move: { x: 0, y: 0 }, dash: false };
      member.lastAppliedSeq = 0;
      member.inputStarved = true;
      member.starveHoldTicks = 0;
      member.backlogWindowMinDepth = Number.POSITIVE_INFINITY;
      member.backlogWindowTicks = 0;
      member.queueDepthEma = 0;
      member.inRun = true;
      member.streaming = true;
      member.matchStart = null;
      member.runOver = null;
      member.persistenceEligible = true;
      member.persistedOutcome = null;
      member.insertionName = insertion.name;
      member.queuedForNextRun = false;
      if (this.hotArena && controller === "ai") expiredTakeovers.push(member);
      squadCounts.set(member.squadId, count + 1);
    }

    if (this.hotArena) {
      for (const role of this.currentRoles) {
        if (role.controller !== "ai" || role.playerId) continue;
        const insertion = insertionBySquad.get(role.squadId)!;
        simulation.spawnBot(
          makeSpawn(role.roleId, role.name, role.squadId, publicSquadColors[role.squadId], insertion, role.slot, [], this.config.botRadius),
          "ai",
        );
      }
    } else {
      for (const [squadId, count] of squadCounts) {
        if (!this.aiWingmates || count >= 2) continue;
        const squadIndex = squads.indexOf(squadId as (typeof squads)[number]);
        const insertion = insertionBySquad.get(squadId)!;
        simulation.spawnBot(
          makeSpawn(`ai-${squadId}`, `${squadId} wing`, squadId, squadColors[squadIndex], insertion, count, [], this.config.botRadius),
          "ai",
        );
      }
    }
    for (const spawn of downtownMap.botSpawns.filter(isAmbientBotSpawn)) {
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
    for (const member of runMembers) {
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
    this.assemblyStartedAt = null;
    this.assemblyDeadlineAt = null;
    for (const member of expiredTakeovers) this.recordDisconnected(member);
    for (const member of runMembers) {
      if (!member.peer && !member.handoffTimer && !expiredTakeovers.includes(member)) this.scheduleHandoff(member);
      this.sendMatchStart(member);
    }
  }

  private sendWelcome(member: Member): void {
    if (this.hotArena) {
      member.peer?.send({
        type: "arenaWelcome",
        playerId: member.playerId,
        arenaId: this.code,
        phase: this.publicPhase(),
        members: this.publicArenaMembers,
        retiring: this.retiring,
        ...(this.assemblyStartedAt === null ? {} : { assemblyStartedAt: this.assemblyStartedAt }),
        ...(this.assemblyDeadlineAt === null ? {} : { assemblyDeadlineAt: this.assemblyDeadlineAt }),
      });
      return;
    }
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
    if (this.hotArena) {
      this.broadcast({
        type: "arenaState",
        phase: this.publicPhase(),
        members: this.publicArenaMembers,
        retiring: this.retiring,
        ...(this.assemblyStartedAt === null ? {} : { assemblyStartedAt: this.assemblyStartedAt }),
        ...(this.assemblyDeadlineAt === null ? {} : { assemblyDeadlineAt: this.assemblyDeadlineAt }),
      });
      return;
    }
    this.broadcast({ type: "lobby", members: this.lobbyMembers, hostId: this.hostId, locked: this.phase !== "lobby" });
  }

  private publicPhase(): "assembling" | "countdown" | "live" | "results" {
    if (this.phase === "assembling" || this.phase === "countdown" || this.phase === "live" || this.phase === "results") return this.phase;
    throw new Error(`Invalid public arena phase ${this.phase}.`);
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
    const wire = toWireSnapshot(snapshot);
    const context = this.viewerContext(member, snapshot);
    const filtered = filterForViewer(wire, snapshot.bots.map(toEntityMeta), context);
    this.resetDotState(member, filtered.dots, visiblePhysicsFloors(wire, context));
    const message: Extract<ServerMessage, { type: "matchStart" }> = {
      type: "matchStart",
      map: downtownMap,
      config: this.simulation.config,
      yourBotId: member.botId,
      meta: snapshot.bots.map(toEntityMeta),
      tickHz: this.simulation.config.tickHz,
      endTick: this.endTick,
      insertionName: member.insertionName ?? "UNKNOWN",
      dotBaseline: filtered.dots,
      intel: this.matchIntel.get(member.playerId),
      ...(this.hotArena && this.matchId ? { matchId: this.matchId, roles: this.currentRoles } : {}),
    };
    member.matchStart = message;
    member.peer?.send(message);
    const own = snapshot.bots.find((bot) => bot.id === member.botId);
    if (own?.state === "downed" && member.lastKillCam && member.activeKillCamId === member.lastKillCam.id) {
      this.sendStream(member, { type: "killCam", clip: toWireKillCamClip(member.lastKillCam) });
    }
    if (member.runOver) member.peer?.send(member.runOver);
  }

  private broadcastSnapshot(snapshot: ReturnType<DotBotSimulation["getSnapshot"]>): void {
    const wire = toWireSnapshot(snapshot);
    const meta = snapshot.bots.map(toEntityMeta);
    for (const member of this.members.values()) {
      if (!member.streaming || !member.peer) continue;
      const context = this.viewerContext(member, snapshot);
      const filtered = filterForViewer(wire, meta, context);
      const dotFrame = this.dotFrame(member, filtered, visiblePhysicsFloors(wire, context));
      this.sendStream(member, { type: "snap", ...toViewerSnapshot(filtered, member.lastAppliedSeq, dotFrame) }, "latest");
    }
  }

  /**
   * Recruitment changes the simulation bot first. Mirror that authoritative
   * squad onto the connected member before interest filtering this tick, then
   * refresh client metadata so snapshots decode the same relationship.
   */
  private syncMemberSquads(snapshot: GameSnapshot): void {
    const changed = [];
    for (const member of this.members.values()) {
      if (!member.botId) continue;
      const bot = snapshot.bots.find((candidate) => candidate.id === member.botId);
      if (!bot || bot.squadId === member.squadId) continue;
      const allowedSquads: readonly string[] = this.hotArena ? PUBLIC_EXTRACTION_SQUADS : squads;
      if (!allowedSquads.includes(bot.squadId)) continue;
      const squadId = bot.squadId as LobbySquadId | PublicExtractionSquadId;
      member.squadId = squadId;
      changed.push(toEntityMeta(bot));
    }
    if (changed.length === 0) return;
    this.broadcast({ type: "meta", add: changed, remove: [] });
  }

  private dotFrame(
    member: Member,
    filtered: FullWireSnapshot,
    contexts: ReadonlySet<string>,
  ): { deltas?: WireDotDelta[]; adds?: WireDot[]; runtimeDots: WireDot[]; sync?: WireDotContextSync[] } {
    const runtimeDots = filtered.dots.filter((dot) => dot.rt);
    const authoredDots = filtered.dots.filter((dot) => !dot.rt);
    if (!sameSet(member.dotContexts, contexts)) {
      const affected = new Set([...member.dotContexts, ...contexts]);
      const sync = [...affected].sort().map((context) => {
        const dots = contexts.has(context)
          ? authoredDots.filter((dot) => physicsFloorId(downtownMap, dot.floorId) === context)
          : [];
        return { context, ...(dots.length ? { dots } : {}) };
      });
      this.resetDotState(member, authoredDots, contexts);
      return { sync, runtimeDots };
    }

    const deltas: WireDotDelta[] = [];
    const adds: WireDot[] = [];
    for (const dot of authoredDots) {
      const previous = member.dotState.get(dot.id);
      const captureProgressMs = dot.captureProgressMs ?? 0;
      if (!previous) {
        adds.push(dot);
      } else {
        const delta: WireDotDelta = { id: dot.id };
        if (previous.active !== dot.active) delta.active = dot.active;
        if (previous.captureProgressMs !== captureProgressMs) delta.captureProgressMs = captureProgressMs;
        if (delta.active !== undefined || delta.captureProgressMs !== undefined) deltas.push(delta);
      }
      member.dotState.set(dot.id, { active: dot.active, captureProgressMs });
    }
    return {
      ...(deltas.length ? { deltas } : {}),
      ...(adds.length ? { adds } : {}),
      runtimeDots,
    };
  }

  private resetDotState(member: Member, dots: readonly WireDot[], contexts: ReadonlySet<string>): void {
    member.dotContexts = new Set(contexts);
    member.dotState = new Map(dots.map((dot) => [
      dot.id,
      { active: dot.active, captureProgressMs: dot.captureProgressMs ?? 0 },
    ]));
  }

  private end(reason: string): void {
    if (this.hotArena) {
      this.endHotRun(reason);
      return;
    }
    if (this.phase === "ended") return;
    if (reason === "all_humans_disconnected") {
      for (const member of this.members.values()) {
        if (member.inRun && !member.peer) this.recordDisconnected(member);
      }
    }
    this.phase = "ended";
    this.endedAt = this.now();
    this.persistenceSettled = false;
    const completedMatchId = this.matchId;
    const pending = [...this.pendingPersistence];
    this.endPromise = Promise.allSettled(pending).then(async () => {
      this.broadcast({ type: "matchEnd", reason });
      if (!completedMatchId) {
        this.persistenceSettled = true;
        return;
      }
      const finishInput = {
        matchId: completedMatchId,
        endedAt: new Date(this.endedAt ?? this.now()),
        summary: this.aggregateMatchSummary(reason),
      };
      await this.settlePersistenceBoundary({
        matchId: completedMatchId,
        settle: async () => {
          await this.settlePendingPersistenceOperations(completedMatchId);
          await this.persistence.finishMatch(finishInput);
        },
        failureMessage: `[persistence] failed to finish match ${completedMatchId}; room remains unsafe to terminate.`,
      });
    });
  }

  private endHotRun(reason: string): void {
    if (this.phase === "results") return;
    if (this.phase !== "live") return;
    if (reason === "all_humans_disconnected") {
      for (const member of this.members.values()) {
        if (member.inRun && !member.peer) this.recordDisconnected(member);
      }
    }
    const completedMatchId = this.matchId;
    this.phase = "results";
    this.endedAt = this.now();
    this.persistenceSettled = false;
    const pending = [...this.pendingPersistence];
    let finishFailed = false;
    this.endPromise = Promise.allSettled(pending).then(async () => {
      if (this.runPersistenceFailed) finishFailed = true;
      this.broadcast({ type: "matchEnd", reason });
      if (!completedMatchId) {
        this.persistenceSettled = true;
        return;
      }
      const settled = await this.settlePersistenceBoundary({
        matchId: completedMatchId,
        settle: async () => {
          await this.settlePendingPersistenceOperations(completedMatchId);
          await this.persistence.finishMatch({
            matchId: completedMatchId,
            endedAt: new Date(this.endedAt ?? this.now()),
            summary: this.aggregateMatchSummary(reason),
          });
        },
        failureMessage: `[persistence] failed to finish match ${completedMatchId}; arena remains unsafe to terminate.`,
      });
      if (!settled) {
        finishFailed = true;
        this.broadcast({ type: "err", code: "storage_unavailable", msg: "This run could not be closed safely. Re-enter quick play." });
      }
    }).finally(() => {
      this.runCount += 1;
      this.simulation?.dispose();
      this.simulation = null;
      this.matchId = null;
      this.currentRoles = [];
      for (const member of [...this.members.values()]) {
        member.botId = null;
        member.inRun = false;
        member.streaming = false;
        member.lastKillCam = null;
        member.activeKillCamId = null;
        if (!member.peer && !member.handoffTimer) {
          this.members.delete(member.playerId);
          this.memberByToken.delete(member.token);
        }
      }
      if (this.disposed) return;
      if (finishFailed || this.runCount >= this.hotArena!.maxRuns || this.now() - this.createdAt >= this.hotArena!.maxAgeMs) {
        this.retiring = true;
      }
      if (!this.retiring && this.readyMembers().length > 0) this.enterPublicAssembly();
      else this.broadcastLobby();
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const member of this.members.values()) member.peer?.send(message);
  }

  private broadcastEvents(events: SimEvent[], snapshot: GameSnapshot): void {
    const meta = snapshot.bots.map(toEntityMeta);
    for (const member of this.members.values()) {
      if (!member.streaming || !member.peer) continue;
      const includedBotIds = this.includedBotIds(member, snapshot);
      const visibleEvents = filterEventsForViewer(events, meta, includedBotIds, member.squadId);
      // An empty reliable packet is still information: its timing tells a rival
      // that a hidden squad just produced a private event (notably mine sensors).
      if (visibleEvents.length === 0) continue;
      this.sendStream(member, {
        type: "ev",
        events: visibleEvents.map(toWireEvent),
      });
    }
  }

  private viewerContext(member: Member, snapshot: GameSnapshot): ViewerContext {
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
    const wire = toWireSnapshot(snapshot);
    const filtered = filterForViewer(
      wire,
      snapshot.bots.map(toEntityMeta),
      this.viewerContext(member, snapshot),
    );
    return new Set(filtered.bots.map((bot) => bot.i));
  }

  private sendStream(member: Member, message: ServerMessage, delivery: DeliveryClass = "reliable"): void {
    const encoded = JSON.stringify(message);
    this.bandwidthWindowBytes += Buffer.byteLength(encoded);
    member.peer?.send(message, delivery, encoded);
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
      /**
       * Extraction is the only event that ends a run.
       *
       * Being looted used to end it, by way of the `consumed` event — which is why
       * losing a fight took you out of the match. It no longer does: a looted bot is
       * a downed bot with empty bays, still on the floor, and the run ends only when
       * that player extracts or leaves.
       */
      if (event.type !== "extracted") continue;
      const member = [...this.members.values()].find((candidate) => candidate.botId === event.botId);
      if (!member?.inRun) continue;
      this.sendRunOver(
        member,
        { type: "runOver", reason: "extracted", keptItems: event.items.map(itemToCode), lostItems: [], learnedBlueprints: [] },
        event.items,
      );
    }
  }

  private processKillCamEvents(events: SimEvent[], snapshot: GameSnapshot): void {
    for (const event of events) {
      if (event.type === "revived" || event.type === "recruited") {
        const revived = [...this.members.values()].find((member) => member.botId === event.botId);
        if (revived) {
          revived.lastKillCam = null;
          revived.activeKillCamId = null;
        }
        continue;
      }
      if (event.type !== "downed") continue;
      const member = [...this.members.values()].find((candidate) => candidate.botId === event.botId);
      if (!member?.inRun) continue;
      const victim = snapshot.bots.find((bot) => bot.id === event.botId);
      if (!victim) continue;
      const cause = event.cause ?? {
        kind: "environment" as const,
        tick: snapshot.debug.tickCount,
        position: { ...victim.position },
        direction: { x: 0, y: 0 },
      };
      const clip = this.killCamHistory.createClip(event.botId, event.byBotId, cause);
      if (!clip) continue;
      member.lastKillCam = clip;
      member.activeKillCamId = clip.id;
      member.inputQueue = [];
      member.heldInput = { move: { x: 0, y: 0 }, dash: false };
      if (member.streaming && member.peer) this.sendStream(member, { type: "killCam", clip: toWireKillCamClip(clip) });
    }
  }

  private sendRunOver(member: Member, message: Extract<ServerMessage, { type: "runOver" }>, cargo: import("@dotbot/game/types").Item[] = []): void {
    member.inRun = false;
    member.inputQueue = [];
    member.heldInput = { move: { x: 0, y: 0 }, dash: false };
    member.runOver = message;
    member.lastKillCam = null;
    member.activeKillCamId = null;
    if (member.persistenceEligible) this.matchOutcomes.set(member.playerId, message.reason);
    const persistenceRequired = Boolean(this.matchId && member.persistenceEligible && this.persistence.live);
    const persistenceMatchId = this.matchId;
    const persistenceMessage = {
      ...message,
      keptItems: [...message.keptItems],
      lostItems: [...message.lostItems],
      learnedBlueprints: [...message.learnedBlueprints],
    };
    const persistenceCargo = [...cargo];
    const operationKey = persistenceMatchId ? `${persistenceMatchId}:${member.persistencePlayerId}` : null;
    const persist = () => this.persistRunOutcome(member, persistenceMessage, persistenceCargo, persistenceMatchId);
    const persistenceWrite = persist()
      .then((manifest) => {
        if (operationKey) this.pendingPersistenceOperations.delete(operationKey);
        message.keptItems = manifest.keptItems;
        message.lostItems = manifest.lostItems;
        message.learnedBlueprints = manifest.learnedBlueprints;
        if (manifest.contractCompletions?.length) message.contractCompletions = manifest.contractCompletions;
        if (persistenceRequired) message.persistenceStatus = "saved";
        member.runOver = message;
      })
      .catch((error) => {
        this.runPersistenceFailed = true;
        if (persistenceMatchId && operationKey && member.persistenceEligible) {
          this.pendingPersistenceOperations.set(operationKey, {
            key: operationKey,
            matchId: persistenceMatchId,
            settle: async () => { await persist(); },
          });
        }
        console.warn(`[persistence] failed to record ${message.reason} for ${member.playerId}; extracted items were not credited. ${safeErrorName(error)}`);
        message.lostItems = [...message.lostItems, ...message.keptItems];
        message.keptItems = [];
        message.learnedBlueprints = [];
        delete message.contractCompletions;
        message.persistenceStatus = "failed";
        member.runOver = message;
        member.peer?.send({ type: "err", code: "save_failed", msg: "The run could not be saved. No extracted items were credited." });
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
      if (this.hotArena && this.matchId) {
        this.simulation?.setController(member.botId, "ai");
        const role = this.currentRoles.find((candidate) => candidate.playerId === member.playerId);
        if (role) {
          role.controller = "ai";
          this.broadcast({
            type: "roleController",
            matchId: this.matchId,
            roleId: role.roleId,
            controller: "ai",
            reason: "player_left",
          });
        }
      } else {
        this.simulation?.removeBot(member.botId);
      }
      member.inRun = false;
    }
    member.streaming = false;
    if (member.handoffTimer) clearTimeout(member.handoffTimer);
    const releasedPeerId = this.hotArena ? member.peer?.id : undefined;
    this.members.delete(member.playerId);
    this.memberByToken.delete(member.token);
    member.peer = null;
    if (releasedPeerId) this.notifyPublicMemberReleased(releasedPeerId, member);
    this.completeIfNoActiveMembers();
  }

  private async persistRunOutcome(
    member: Member,
    message: Extract<ServerMessage, { type: "runOver" }>,
    cargo: import("@dotbot/game/types").Item[],
    matchId: string | null = this.matchId,
  ): Promise<RunManifest> {
    const unchanged: RunManifest = {
      reason: message.reason,
      keptItems: message.keptItems,
      lostItems: message.lostItems,
      learnedBlueprints: message.learnedBlueprints,
      cargo,
      contractCompletions: message.contractCompletions ?? [],
    };
    if (!matchId || !member.persistenceEligible) return unchanged;
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
        matchId,
        playerId: member.persistencePlayerId,
        manifest,
        blueprintLearningThreshold: this.config.blueprintLearningThreshold,
      });
      member.persistedOutcome = message.reason;
      return result.manifest;
    }
    await this.persistence.recordOutcome({ matchId, playerId: member.persistencePlayerId, outcome: message.reason });
    member.persistedOutcome = message.reason;
    return unchanged;
  }

  private recordDisconnected(member: Member): void {
    if (!this.matchId || !member.persistenceEligible || member.persistedOutcome || member.runOver) return;
    member.persistenceEligible = false;
    this.matchOutcomes.set(member.playerId, "disconnected");
    const input = {
      matchId: this.matchId,
      playerId: member.persistencePlayerId,
      outcome: "disconnected" as const,
    };
    const operationKey = `${input.matchId}:${input.playerId}`;
    const settle = () => this.persistence.recordOutcome(input);
    const write = settle().then(() => {
      this.pendingPersistenceOperations.delete(operationKey);
      member.persistedOutcome = "disconnected";
    }).catch((error) => {
      this.runPersistenceFailed = true;
      this.pendingPersistenceOperations.set(operationKey, {
        key: operationKey,
        matchId: input.matchId,
        settle: async () => {
          await settle();
          member.persistedOutcome = "disconnected";
        },
      });
      console.warn(`[persistence] failed to record disconnect for ${member.playerId}; run continued. ${safeErrorName(error)}`);
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

  private aggregateMatchSummary(reason: string) {
    return {
      reason,
      participantCount: this.matchOutcomes.size,
      outcomes: [...this.matchOutcomes.values()].reduce<Record<string, number>>((counts, outcome) => {
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }

  private async settlePersistenceBoundary(settlement: PendingPersistenceSettlement): Promise<boolean> {
    try {
      await settlement.settle();
      if (this.pendingPersistenceSettlement?.matchId === settlement.matchId) this.pendingPersistenceSettlement = null;
      for (const [key, operation] of this.pendingPersistenceOperations) {
        if (operation.matchId === settlement.matchId) this.pendingPersistenceOperations.delete(key);
      }
      this.persistenceSettlementRetryAt = Number.POSITIVE_INFINITY;
      this.persistenceSettled = true;
      return true;
    } catch (error) {
      this.runPersistenceFailed = true;
      this.pendingPersistenceSettlement = settlement;
      this.persistenceSettlementRetryAt = this.now() + persistenceSettlementRetryMs;
      this.persistenceSettled = false;
      console.warn(`${settlement.failureMessage} ${safeErrorName(error)}`);
      return false;
    }
  }

  private retryPersistenceSettlement(now: number): void {
    if (!this.pendingPersistenceSettlement || this.persistenceSettlementRetryInFlight || now < this.persistenceSettlementRetryAt) return;
    const settlement = this.pendingPersistenceSettlement;
    this.persistenceSettlementRetryInFlight = true;
    this.persistenceSettlementRetryAt = Number.POSITIVE_INFINITY;
    this.endPromise = this.settlePersistenceBoundary(settlement)
      .then(() => undefined)
      .finally(() => {
        this.persistenceSettlementRetryInFlight = false;
      });
  }

  private async settlePendingPersistenceOperations(matchId: string): Promise<void> {
    const operations = [...this.pendingPersistenceOperations.values()].filter((operation) => operation.matchId === matchId);
    await Promise.all(operations.map(async (operation) => {
      await operation.settle();
      if (this.pendingPersistenceOperations.get(operation.key) === operation) {
        this.pendingPersistenceOperations.delete(operation.key);
      }
    }));
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
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

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "UnknownError";
}

function normalizeHotArenaOptions(options: HotArenaOptions): Required<HotArenaOptions> {
  const normalized = {
    assemblyMinMs: options.assemblyMinMs ?? defaultHotArenaMinMs,
    assemblyMaxMs: options.assemblyMaxMs ?? defaultHotArenaMaxMs,
    maxRuns: options.maxRuns ?? defaultHotArenaMaxRuns,
    maxAgeMs: options.maxAgeMs ?? defaultHotArenaMaxAgeMs,
    minInsertionSpacing: options.minInsertionSpacing ?? defaultHotArenaMinInsertionSpacing,
  };
  if (!Number.isFinite(normalized.assemblyMinMs) || normalized.assemblyMinMs < 1_000) {
    throw new Error("Public assembly must run for at least one second.");
  }
  if (!Number.isFinite(normalized.assemblyMaxMs) || normalized.assemblyMaxMs > 6_000 || normalized.assemblyMaxMs < normalized.assemblyMinMs) {
    throw new Error("Public assembly must finish between its minimum and six seconds.");
  }
  if (!Number.isInteger(normalized.maxRuns) || normalized.maxRuns < 1) throw new Error("Hot-arena maxRuns must be a positive integer.");
  if (!Number.isFinite(normalized.maxAgeMs) || normalized.maxAgeMs < normalized.assemblyMaxMs) throw new Error("Hot-arena maxAgeMs is too small.");
  if (!Number.isFinite(normalized.minInsertionSpacing) || normalized.minInsertionSpacing < 0) throw new Error("Hot-arena insertion spacing must be non-negative.");
  return normalized;
}

function sanitizePartyId(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (normalized && normalized.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(normalized)) return normalized;
  return `solo-${fallback.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 96) || "player"}`;
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
