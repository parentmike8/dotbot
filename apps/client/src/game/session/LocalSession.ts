import { DotBotSimulation } from "@dotbot/game/simulation";
import { carriedItems } from "@dotbot/game/inventory";
import type { GameConfig, GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";
import { KILL_CAM_HISTORY_SECONDS, KillCamHistory, type EntityMeta, type KillCamClip } from "@dotbot/protocol";
import type { GameSession } from "./GameSession";
import type { RunState } from "./GameSession";

export type LocalSimulation = Pick<
  DotBotSimulation,
  "applyInput" | "dispose" | "drainEvents" | "getSnapshot" | "setMeasuredFps" | "step"
> & Partial<Pick<DotBotSimulation, "removeBot" | "setDoorLocked" | "setMapObjectEnabled">>;

export type LocalSessionOptions = {
  map: MapDocument;
  config: GameConfig;
  playerId: string;
  createSimulation?: () => Promise<LocalSimulation>;
  inputObserver?: (input: InputCommand) => void;
};

export class LocalSession implements GameSession {
  readonly map: MapDocument;
  readonly playerId: string;

  private readonly config: GameConfig;
  private readonly createSimulation: () => Promise<LocalSimulation>;
  private readonly inputObserver?: (input: InputCommand) => void;
  private readonly killCamHistory: KillCamHistory;
  private readonly killCamSampleStride: number;
  private simulation: LocalSimulation | null = null;
  private accumulator = 0;
  private stepsSinceKillCamSample = 0;
  private input: InputCommand = { move: { x: 0, y: 0 }, dash: false };
  private events: SimEvent[] = [];
  private killCams: KillCamClip[] = [];
  private replayActive = false;
  private runState: RunState = { phase: "live" };
  private lastSnapshot: GameSnapshot | null = null;

  constructor(options: LocalSessionOptions) {
    this.map = options.map;
    this.config = options.config;
    this.playerId = options.playerId;
    this.createSimulation = options.createSimulation ?? (() => DotBotSimulation.create({ map: this.map, config: this.config }));
    this.inputObserver = options.inputObserver;
    this.killCamHistory = new KillCamHistory(this.map, { historyTicks: KILL_CAM_HISTORY_SECONDS * this.config.tickHz });
    this.killCamSampleStride = Math.max(1, Math.round(this.config.tickHz / 20));
  }

  async start(): Promise<void> {
    this.simulation = await this.createSimulation();
    const snapshot = this.simulation.getSnapshot();
    this.lastSnapshot = snapshot;
    this.killCamHistory.record(snapshot);
  }

  sendInput(input: InputCommand): void {
    this.inputObserver?.(input);
    if (this.replayActive) {
      this.input = { move: { x: 0, y: 0 }, dash: false, plea: input.plea };
      this.simulation?.applyInput(this.playerId, this.input);
      return;
    }
    this.input = { move: input.move, dash: false, downedVerb: input.downedVerb, plea: false };
    // Hand the intent to the sim immediately so its own sticky Dash queue
    // retains a press even when this render frame does not produce a tick.
    // Subsequent ticks reapply movement with Dash false, matching the old
    // hook's once-per-press Dash clearing without adding a second queue.
    this.simulation?.applyInput(this.playerId, input);
  }

  setMapObjectEnabled(objectId: string, enabled: boolean): boolean {
    return this.simulation?.setMapObjectEnabled?.(objectId, enabled) ?? false;
  }

  setDoorLocked(doorwayId: string, locked: boolean): boolean {
    return this.simulation?.setDoorLocked?.(doorwayId, locked) ?? false;
  }

  removeBot(botId: string): void {
    this.simulation?.removeBot?.(botId);
  }

  update(elapsedMs: number): GameSnapshot | null {
    const simulation = this.simulation;
    if (!simulation) {
      return null;
    }

    const deltaSeconds = Math.min(0.1, elapsedMs / 1000);
    const tickSeconds = 1 / this.config.tickHz;
    this.accumulator += deltaSeconds;

    while (this.accumulator >= tickSeconds) {
      simulation.applyInput(this.playerId, this.input);
      simulation.step();
      const frameEvents = simulation.drainEvents();
      this.killCamHistory.recordEvents(frameEvents);
      this.stepsSinceKillCamSample += 1;
      const playerDowned = frameEvents.some((event) =>
        event.type === "downed" && event.botId === this.playerId);
      if (playerDowned || this.stepsSinceKillCamSample >= this.killCamSampleStride) {
        const tickSnapshot = simulation.getSnapshot();
        this.killCamHistory.record(tickSnapshot);
        this.stepsSinceKillCamSample = 0;
        if (playerDowned) this.captureKillCam(frameEvents, tickSnapshot);
      }
      // The renderer/sensory layer consumes hit events in the same frame in
      // local mode too. The hook keeps them out of long-lived React history.
      this.events.push(...frameEvents);
      this.applyRunEvents(frameEvents);
      this.accumulator -= tickSeconds;
    }

    const snapshot = simulation.getSnapshot();
    this.lastSnapshot = snapshot;
    if (this.runState.phase === "live" && snapshot.timeMs >= this.config.runDurationMs) {
      this.runState = {
        phase: "over",
        reason: "timeout",
        keptItems: [],
        lostItems: snapshot.bots.find((bot) => bot.id === this.playerId)
          ? carriedItems(snapshot.bots.find((bot) => bot.id === this.playerId)!)
          : [],
        learnedBlueprints: [],
      };
    }
    return snapshot;
  }

  drainEvents(): SimEvent[] {
    return this.events.splice(0);
  }

  drainKillCams(): KillCamClip[] {
    return this.killCams.splice(0);
  }

  setReplayActive(active: boolean): void {
    this.replayActive = active;
    if (!active) return;
    this.input = { move: { x: 0, y: 0 }, dash: false };
    this.simulation?.applyInput(this.playerId, this.input);
  }

  getEntityMeta(id: string): EntityMeta | undefined {
    const bot = this.lastSnapshot?.bots.find((candidate) => candidate.id === id);
    return bot ? {
      id: bot.id,
      name: bot.name,
      squadId: bot.squadId,
      isAmbient: bot.isAmbient,
      maxShields: bot.maxShields,
      radius: bot.radius,
      color: bot.color,
    } : undefined;
  }

  getRunState(): RunState {
    return this.runState;
  }

  leaveRun(): void {
    if (this.runState.phase === "over") return;
    const player = this.lastSnapshot?.bots.find((bot) => bot.id === this.playerId);
    if (!player || player.state !== "downed") return;
    this.runState = { phase: "over", reason: "died", keptItems: [], lostItems: carriedItems(player), learnedBlueprints: [] };
  }

  setMeasuredFps(fps: number): void {
    this.simulation?.setMeasuredFps(fps);
  }

  dispose(): void {
    this.simulation?.dispose();
    this.simulation = null;
    this.accumulator = 0;
    this.stepsSinceKillCamSample = 0;
    this.events = [];
    this.killCams = [];
    this.replayActive = false;
    this.runState = { phase: "live" };
    this.lastSnapshot = null;
  }

  private captureKillCam(events: readonly SimEvent[], snapshot: GameSnapshot): void {
    for (const event of events) {
      if (event.type !== "downed" || event.botId !== this.playerId) continue;
      const victim = snapshot.bots.find((bot) => bot.id === event.botId);
      if (!victim) continue;
      const cause = event.cause ?? {
        kind: "environment" as const,
        tick: snapshot.debug.tickCount,
        position: { ...victim.position },
        direction: { x: 0, y: 0 },
      };
      const clip = this.killCamHistory.createClip(event.botId, event.byBotId, cause);
      if (clip) this.killCams.push(clip);
    }
  }

  private applyRunEvents(events: SimEvent[]): void {
    if (this.runState.phase === "over") return;
    for (const event of events) {
      if (event.botId !== this.playerId) continue;
      if (event.type === "extracted") {
        this.runState = { phase: "over", reason: "extracted", keptItems: event.items, lostItems: [], learnedBlueprints: [] };
        return;
      }
      // Being looted does not end a run. Only extracting does, or leaving.
    }
  }
}
