import type { GameConfig, GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";
import { physicsFloorId } from "@dotbot/game/mapModel";
import { applyWireDotFrame, assertNever, fromWireEvent, fromWireSnapshot, itemFromCode } from "@dotbot/protocol";
import type { EntityMeta, LobbyMember, LobbySquadId, MatchIntel, ServerMessage, WireDot } from "@dotbot/protocol";
import { LitePredictor, type PredictedOwnBot } from "../prediction/LitePredictor";
import {
  blendOffset,
  classifyCorrection,
  dropAcknowledgedInputs,
  replayPendingInputs,
  type PendingInput,
} from "../prediction/reconciliation";
import type { GameSession, RunState } from "./GameSession";
import { snapshotArrivalStats, type NetworkDebugStats } from "./netgraph";
import { capRemoteRecovery, sampleTimeline, type TimelineSnapshot } from "./interpolation";

export type NetSessionOptions = {
  url: string;
  roomCode: string;
  name: string;
  token: string;
  preferredSquad?: LobbySquadId;
  onLobby?: (state: { roomCode: string; members: LobbyMember[]; hostId: string; playerId: string; locked: boolean }) => void;
  onError?: (message: string) => void;
};

type BufferedSnapshot = TimelineSnapshot;

const interpolationDelayMs = 125;
const snapshotIntervalMs = 50;
const maxRemoteCorrectionSpeedPxPerSecond = 1000;

export class NetSession implements GameSession {
  private readonly options: NetSessionOptions;
  private socket: WebSocket | null = null;
  private mapValue: MapDocument | null = null;
  private configValue: GameConfig | null = null;
  private playerIdValue = "";
  private metaIndex = new Map<string, EntityMeta>();
  private snapshots: BufferedSnapshot[] = [];
  private events: SimEvent[] = [];
  private seq = 0;
  private sendFrame = false;
  private pendingInput: InputCommand = { move: { x: 0, y: 0 }, dash: false };
  private pendingInputs: PendingInput[] = [];
  private predictionInput: InputCommand = { move: { x: 0, y: 0 }, dash: false };
  private predictionDashQueued = false;
  private predictor: LitePredictor | null = null;
  private predictionAccumulatorMs = 0;
  private predictionEnabled = false;
  private correctionOffset = { x: 0, y: 0 };
  private correctionElapsedMs = 100;
  private tickHz = 60;
  private roomCode = "";
  private startPromise: Promise<void> | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private runState: RunState = { phase: "live" };
  private endTick = Number.MAX_SAFE_INTEGER;
  private insertionNameValue = "";
  private warnedClockDrift = false;
  private intelValue: MatchIntel | undefined;
  private dotStore = new Map<string, WireDot>();
  private readonly snapshotIntervalsMs: number[] = [];
  private lastSnapshotArrivalMs: number | null = null;
  private rttMs: number | null = null;
  private lastPingSentAtMs = 0;
  private bufferDepthSnapshots = 0;
  private predictionErrorPx = 0;
  private readonly correctionTimesMs: number[] = [];
  private serverClockTick: number | null = null;
  private serverClockClientMs = 0;
  private lastRenderTick = Number.NEGATIVE_INFINITY;
  private lastRenderedRemote: GameSnapshot | null = null;

  constructor(options: NetSessionOptions) {
    this.options = options;
  }

  get map(): MapDocument {
    if (!this.mapValue) throw new Error("NetSession map is unavailable until matchStart");
    return this.mapValue;
  }

  get config(): GameConfig {
    if (!this.configValue) throw new Error("NetSession config is unavailable until matchStart");
    return this.configValue;
  }

  get playerId(): string {
    return this.playerIdValue;
  }

  get insertionName(): string {
    return this.insertionNameValue;
  }

  get intel(): MatchIntel | undefined {
    return this.intelValue;
  }

  getEntityMeta(id: string): EntityMeta | undefined {
    return this.metaIndex.get(id);
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      const socket = new WebSocket(resolveWebSocketUrl(this.options.url));
      this.socket = socket;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          token: this.options.token,
          name: this.options.name,
          roomCode: this.options.roomCode.trim().toUpperCase(),
          preferredSquad: this.options.preferredSquad,
        }));
      });
      socket.addEventListener("message", (event) => this.receive(JSON.parse(String(event.data)) as ServerMessage));
      socket.addEventListener("error", () => this.failStart("Unable to connect to the game server."));
      socket.addEventListener("close", () => {
        if (!this.mapValue) this.failStart("The game server closed the connection.");
      });
    });
    return this.startPromise;
  }

  requestStartMatch(): void {
    this.send({ type: "startMatch" });
  }

  requestSquad(squadId: LobbySquadId): void {
    this.send({ type: "joinSquad", squadId });
  }

  leaveRun(): void {
    this.send({ type: "leaveRun" });
  }

  giveUp(): void {
    this.leaveRun();
  }

  sendInput(input: InputCommand): void {
    this.predictionInput = { move: { ...input.move }, dash: false };
    this.predictionDashQueued ||= input.dash;
    this.pendingInput = {
      move: { ...input.move },
      dash: this.pendingInput.dash || input.dash,
      useBay: this.pendingInput.useBay ?? input.useBay,
      swapBay: this.pendingInput.swapBay ?? input.swapBay,
      downedVerb: input.downedVerb,
      plea: this.pendingInput.plea || input.plea,
    };
    this.sendFrame = !this.sendFrame;
    if (!this.sendFrame || !this.mapValue) return;
    this.seq += 1;
    const sentInput = {
      move: { ...this.pendingInput.move },
      dash: this.pendingInput.dash,
      useBay: this.pendingInput.useBay,
      swapBay: this.pendingInput.swapBay,
      downedVerb: this.pendingInput.downedVerb,
      plea: this.pendingInput.plea,
    };
    this.send({
      type: "input",
      seq: this.seq,
      move: [sentInput.move.x, sentInput.move.y],
      dash: sentInput.dash,
      useBay: sentInput.useBay,
      swapBay: sentInput.swapBay,
      downedVerb: sentInput.downedVerb,
      plea: sentInput.plea,
    });
    this.pendingInputs.push({ seq: this.seq, input: sentInput });
    this.pendingInput = { move: this.pendingInput.move, dash: false, downedVerb: this.pendingInput.downedVerb, plea: false };
  }

  getNetworkDebug(): NetworkDebugStats {
    const now = performance.now();
    this.pruneCorrections(now);
    return {
      snapshotIntervalsMs: this.snapshotIntervalsMs.slice(-64),
      ...snapshotArrivalStats(this.snapshotIntervalsMs),
      rttMs: this.rttMs,
      interpolationDelayMs,
      bufferDepthSnapshots: this.bufferDepthSnapshots,
      predictionErrorPx: this.predictionErrorPx,
      correctionsPerSecond: this.correctionTimesMs.length,
    };
  }

  update(elapsedMs: number): GameSnapshot | null {
    if (this.snapshots.length === 0) return null;
    this.maybePing();
    this.advancePrediction(elapsedMs);
    const newest = this.snapshots[this.snapshots.length - 1];
    const estimatedServerTick = this.estimatedServerTick(performance.now()) ?? newest.tick;
    const desiredRenderTick = estimatedServerTick - interpolationDelayMs / (1000 / this.tickHz);
    const renderTick = Math.max(this.lastRenderTick, desiredRenderTick);
    this.lastRenderTick = renderTick;
    const sampled = sampleTimeline(this.snapshots, renderTick, snapshotIntervalMs / (1000 / this.tickHz));
    if (!sampled) return null;
    this.bufferDepthSnapshots = sampled.bufferDepthSnapshots;
    const remote = capRemoteRecovery(
      this.lastRenderedRemote,
      sampled.snapshot,
      this.playerIdValue,
      elapsedMs,
      maxRemoteCorrectionSpeedPxPerSecond,
    );
    this.lastRenderedRemote = remote;
    return this.withPredictedOwnBot(remote, newest.snapshot);
  }

  drainEvents(): SimEvent[] {
    return this.events.splice(0);
  }

  getRunState(): RunState {
    return this.runState;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
    this.snapshots = [];
    this.events = [];
    this.pendingInputs = [];
    this.predictor = null;
    this.dotStore.clear();
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.playerIdValue = message.playerId;
        this.roomCode = message.roomCode;
        this.options.onLobby?.({
          roomCode: message.roomCode,
          members: message.members,
          hostId: message.hostId,
          playerId: message.playerId,
          locked: message.locked,
        });
        return;
      case "lobby":
        this.options.onLobby?.({
          roomCode: this.roomCode || this.options.roomCode,
          members: message.members,
          hostId: message.hostId,
          playerId: this.playerIdValue,
          locked: message.locked,
        });
        return;
      case "matchStart":
        this.mapValue = message.map;
        this.configValue = message.config;
        this.playerIdValue = message.yourBotId;
        this.tickHz = message.tickHz;
        this.endTick = message.endTick;
        this.insertionNameValue = message.insertionName;
        this.intelValue = message.intel;
        this.metaIndex = new Map(message.meta.map((meta) => [meta.id, meta]));
        this.dotStore = new Map(message.dotBaseline.map((dot) => [dot.id, { ...dot, position: { ...dot.position } }]));
        this.runState = { phase: "live" };
        this.resolveStart?.();
        this.resolveStart = null;
        this.rejectStart = null;
        return;
      case "snap": {
        const arrivedAt = this.recordSnapshotArrival();
        if (this.serverClockTick === null) this.setServerClock(message.tick, arrivedAt);
        if (this.intelValue && message.intel !== undefined) {
          this.intelValue = { ...this.intelValue, signal: message.intel.signal };
        }
        if (!this.mapValue) return;
        applyWireDotFrame(this.dotStore, message, (floorId) => physicsFloorId(this.mapValue!, floorId));
        const snapshot = fromWireSnapshot(message, this.metaIndex, [...this.dotStore.values()]);
        snapshot.timeMs = message.tick * (1000 / this.tickHz);
        snapshot.debug.tickHz = this.tickHz;
        this.checkClockSanity(message.tick, snapshot.timeMs);
        this.reconcileOwnBot(snapshot, message.ack);
        this.snapshots.push({ tick: message.tick, snapshot });
        if (this.snapshots.length > 20) this.snapshots.splice(0, this.snapshots.length - 20);
        return;
      }
      case "meta":
        for (const id of message.remove) this.metaIndex.delete(id);
        for (const meta of message.add) this.metaIndex.set(meta.id, meta);
        return;
      case "ev":
        this.events.push(...message.events.map(fromWireEvent));
        return;
      case "runOver":
        this.runState = {
          phase: "over",
          reason: message.reason,
          keptItems: message.keptItems.map(itemFromCode),
          lostItems: message.lostItems.map(itemFromCode),
          learnedBlueprints: message.learnedBlueprints,
          contractCompletions: (message.contractCompletions ?? []).map((completion) => ({
            ...completion,
            payout: completion.payout.map(itemFromCode),
          })),
        };
        return;
      case "matchEnd":
        return;
      case "pong":
        this.rttMs = Math.max(0, Date.now() - message.cts);
        if (message.tick !== undefined && message.tick > 0) {
          this.correctServerClock(message.tick, performance.now() - this.rttMs / 2);
        }
        return;
      case "err":
        this.failStart(message.msg);
        return;
      default:
        return assertNever(message);
    }
  }

  private send(message: import("@dotbot/protocol").ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private advancePrediction(elapsedMs: number): void {
    if (!this.predictor || !this.predictionEnabled) {
      this.predictionDashQueued = false;
      return;
    }

    this.predictionAccumulatorMs += Math.min(elapsedMs, 250);
    while (this.predictionAccumulatorMs >= this.predictor.tickMs) {
      this.predictor.step({ ...this.predictionInput, dash: this.predictionDashQueued });
      this.predictionDashQueued = false;
      this.predictionAccumulatorMs -= this.predictor.tickMs;
    }
    this.correctionElapsedMs += elapsedMs;
  }

  private reconcileOwnBot(snapshot: GameSnapshot, ack: number): void {
    const authoritative = snapshot.bots.find((bot) => bot.id === this.playerIdValue);
    this.pendingInputs = dropAcknowledgedInputs(this.pendingInputs, ack);
    if (!authoritative || !this.mapValue || !this.configValue) {
      this.predictor = null;
      this.predictionEnabled = false;
      return;
    }

    this.predictionEnabled = authoritative.state === "alive";
    if (!this.predictor) {
      this.predictor = new LitePredictor(this.mapValue, this.configValue, authoritative);
      this.predictionAccumulatorMs = 0;
      return;
    }

    const predictedBefore = this.predictor.current;
    if (authoritative.floorId !== predictedBefore.floorId || !this.predictionEnabled) {
      this.predictor.reset(authoritative);
      this.predictionAccumulatorMs = 0;
      this.correctionOffset = { x: 0, y: 0 };
      this.correctionElapsedMs = 100;
      return;
    }

    const replay = replayPendingInputs(this.predictor, authoritative, this.pendingInputs, ack);
    this.pendingInputs = replay.pending;
    const error = Math.hypot(
      replay.corrected.position.x - predictedBefore.position.x,
      replay.corrected.position.y - predictedBefore.position.y,
    );
    this.predictionErrorPx = error;
    if (error >= 0.5) {
      const now = performance.now();
      this.correctionTimesMs.push(now);
      this.pruneCorrections(now);
    }
    const kind = classifyCorrection(error, authoritative.radius);
    if (kind === "blend") {
      this.correctionOffset = {
        x: predictedBefore.position.x - replay.corrected.position.x,
        y: predictedBefore.position.y - replay.corrected.position.y,
      };
      this.correctionElapsedMs = 0;
    } else {
      this.correctionOffset = { x: 0, y: 0 };
      this.correctionElapsedMs = 100;
    }
  }

  private withPredictedOwnBot(snapshot: GameSnapshot, freshest: GameSnapshot): GameSnapshot {
    if (!this.predictor) return snapshot;
    const predicted = this.predictor.current;
    const offset = blendOffset(this.correctionOffset, this.correctionElapsedMs);
    const freshOwn = freshest.bots.find((bot) => bot.id === this.playerIdValue);
    return {
      ...snapshot,
      bots: snapshot.bots.map((bot) =>
        bot.id === this.playerIdValue
          ? this.mergePredictedBot(bot, freshOwn ?? bot, predicted, offset)
          : bot,
      ),
    };
  }

  private mergePredictedBot(
    authoritative: GameSnapshot["bots"][number],
    freshest: GameSnapshot["bots"][number],
    predicted: PredictedOwnBot,
    offset: { x: number; y: number },
  ): GameSnapshot["bots"][number] {
    return {
      ...authoritative,
      shields: freshest.shields,
      shieldSegments: freshest.shieldSegments,
      bays: freshest.bays,
      hold: freshest.hold,
      carriedCount: freshest.carriedCount,
      position: {
        x: predicted.position.x + offset.x,
        y: predicted.position.y + offset.y,
      },
      facing: predicted.facing,
      floorId: predicted.floorId,
      dashCooldownMs: predicted.dashCooldownMs,
      dashActiveMs: predicted.dashActiveMs,
    };
  }

  private failStart(message: string): void {
    this.options.onError?.(message);
    this.rejectStart?.(new Error(message));
    this.resolveStart = null;
    this.rejectStart = null;
  }

  private maybePing(): void {
    const now = performance.now();
    if (now - this.lastPingSentAtMs < 1000) return;
    this.lastPingSentAtMs = now;
    this.send({ type: "ping", cts: Date.now() });
  }

  private recordSnapshotArrival(): number {
    const now = performance.now();
    if (this.lastSnapshotArrivalMs !== null) {
      this.snapshotIntervalsMs.push(now - this.lastSnapshotArrivalMs);
      if (this.snapshotIntervalsMs.length > 240) this.snapshotIntervalsMs.shift();
    }
    this.lastSnapshotArrivalMs = now;
    return now;
  }

  private pruneCorrections(now: number): void {
    while (this.correctionTimesMs[0] !== undefined && now - this.correctionTimesMs[0] > 1000) {
      this.correctionTimesMs.shift();
    }
  }

  private estimatedServerTick(clientMs: number): number | null {
    if (this.serverClockTick === null) return null;
    return this.serverClockTick + (clientMs - this.serverClockClientMs) / (1000 / this.tickHz);
  }

  private setServerClock(tick: number, clientMs: number): void {
    this.serverClockTick = tick;
    this.serverClockClientMs = clientMs;
  }

  private correctServerClock(tick: number, clientMidpointMs: number): void {
    const estimated = this.estimatedServerTick(clientMidpointMs);
    if (estimated === null) {
      this.setServerClock(tick, clientMidpointMs);
      return;
    }
    const correction = Math.max(-1, Math.min(1, (tick - estimated) * 0.25));
    this.setServerClock(estimated + correction, clientMidpointMs);
  }

  private checkClockSanity(tick: number, snapshotTimeMs: number): void {
    if (!import.meta.env.DEV || this.warnedClockDrift || !this.configValue) return;
    const tickMs = 1000 / this.tickHz;
    const snapshotRemainingMs = this.configValue.runDurationMs - snapshotTimeMs;
    const endTickRemainingMs = (this.endTick - tick) * tickMs;
    if (Math.abs(snapshotRemainingMs - endTickRemainingMs) > tickMs * 2) {
      this.warnedClockDrift = true;
      console.warn("DotBot run clock differs from authoritative endTick by more than two ticks.", {
        snapshotRemainingMs,
        endTickRemainingMs,
        tick,
        endTick: this.endTick,
      });
    }
  }
}

function resolveWebSocketUrl(value: string): string {
  if (/^wss?:\/\//.test(value)) return value;
  const url = new URL(value, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
