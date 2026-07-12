import type { GameConfig, GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";
import { assertNever, fromWireSnapshot } from "@dotbot/protocol";
import type { EntityMeta, LobbyMember, ServerMessage } from "@dotbot/protocol";
import { LitePredictor, type PredictedOwnBot } from "../prediction/LitePredictor";
import {
  blendOffset,
  classifyCorrection,
  dropAcknowledgedInputs,
  replayPendingInputs,
  type PendingInput,
} from "../prediction/reconciliation";
import type { GameSession, RunState } from "./GameSession";

export type NetSessionOptions = {
  url: string;
  roomCode: string;
  name: string;
  token: string;
  onLobby?: (state: { roomCode: string; members: LobbyMember[]; hostId: string; playerId: string }) => void;
  onError?: (message: string) => void;
};

type BufferedSnapshot = { tick: number; snapshot: GameSnapshot };

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
  private warnedClockDrift = false;

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

  leaveRun(): void {
    this.send({ type: "leaveRun" });
  }

  sendInput(input: InputCommand): void {
    this.predictionInput = { move: { ...input.move }, dash: false };
    this.predictionDashQueued ||= input.dash;
    this.pendingInput = {
      move: { ...input.move },
      dash: this.pendingInput.dash || input.dash,
    };
    this.sendFrame = !this.sendFrame;
    if (!this.sendFrame || !this.mapValue) return;
    this.seq += 1;
    const sentInput = {
      move: { ...this.pendingInput.move },
      dash: this.pendingInput.dash,
    };
    this.send({
      type: "input",
      seq: this.seq,
      move: [sentInput.move.x, sentInput.move.y],
      dash: sentInput.dash,
    });
    this.pendingInputs.push({ seq: this.seq, input: sentInput });
    this.pendingInput = { move: this.pendingInput.move, dash: false };
  }

  update(elapsedMs: number): GameSnapshot | null {
    if (this.snapshots.length === 0) return null;
    this.advancePrediction(elapsedMs);
    const newest = this.snapshots[this.snapshots.length - 1];
    const renderTick = newest.tick - this.tickHz * 0.1;
    let older = this.snapshots[0];
    let newer = newest;

    for (let index = 0; index < this.snapshots.length; index += 1) {
      const candidate = this.snapshots[index];
      if (candidate.tick <= renderTick) older = candidate;
      if (candidate.tick >= renderTick) {
        newer = candidate;
        break;
      }
    }
    if (older.tick === newer.tick) return this.withPredictedOwnBot(older.snapshot);
    const alpha = Math.max(0, Math.min(1, (renderTick - older.tick) / (newer.tick - older.tick)));
    const newerBots = new Map(newer.snapshot.bots.map((bot) => [bot.id, bot]));
    return this.withPredictedOwnBot({
      ...older.snapshot,
      timeMs: lerp(older.snapshot.timeMs, newer.snapshot.timeMs, alpha),
      bots: older.snapshot.bots.map((bot) => {
        const next = newerBots.get(bot.id);
        if (!next) return bot;
        return {
          ...bot,
          position: {
            x: lerp(bot.position.x, next.position.x, alpha),
            y: lerp(bot.position.y, next.position.y, alpha),
          },
          facing: lerpAngle(bot.facing, next.facing, alpha),
        };
      }),
    });
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
        });
        return;
      case "lobby":
        this.options.onLobby?.({
          roomCode: this.roomCode || this.options.roomCode,
          members: message.members,
          hostId: message.hostId,
          playerId: this.playerIdValue,
        });
        return;
      case "matchStart":
        this.mapValue = message.map;
        this.configValue = message.config;
        this.playerIdValue = message.yourBotId;
        this.tickHz = message.tickHz;
        this.endTick = message.endTick;
        this.metaIndex = new Map(message.meta.map((meta) => [meta.id, meta]));
        this.runState = { phase: "live" };
        this.resolveStart?.();
        this.resolveStart = null;
        this.rejectStart = null;
        return;
      case "snap": {
        const snapshot = fromWireSnapshot(message, this.metaIndex);
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
        this.events.push(...message.events);
        return;
      case "runOver":
        this.runState = {
          phase: "over",
          reason: message.reason,
          keptDots: message.keptDots,
          lostDots: message.lostDots,
        };
        return;
      case "matchEnd":
        return;
      case "pong":
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

  private withPredictedOwnBot(snapshot: GameSnapshot): GameSnapshot {
    if (!this.predictor) return snapshot;
    const predicted = this.predictor.current;
    const offset = blendOffset(this.correctionOffset, this.correctionElapsedMs);
    return {
      ...snapshot,
      bots: snapshot.bots.map((bot) =>
        bot.id === this.playerIdValue
          ? this.mergePredictedBot(bot, predicted, offset)
          : bot,
      ),
    };
  }

  private mergePredictedBot(
    authoritative: GameSnapshot["bots"][number],
    predicted: PredictedOwnBot,
    offset: { x: number; y: number },
  ): GameSnapshot["bots"][number] {
    return {
      ...authoritative,
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

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpAngle(a: number, b: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * alpha;
}
