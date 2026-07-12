import { DotBotSimulation } from "@dotbot/game/simulation";
import { carriedItems } from "@dotbot/game/inventory";
import type { GameConfig, GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";
import type { GameSession } from "./GameSession";
import type { RunState } from "./GameSession";

export type LocalSimulation = Pick<
  DotBotSimulation,
  "applyInput" | "dispose" | "drainEvents" | "getSnapshot" | "setMeasuredFps" | "step"
>;

export type LocalSessionOptions = {
  map: MapDocument;
  config: GameConfig;
  playerId: string;
  createSimulation?: () => Promise<LocalSimulation>;
};

export class LocalSession implements GameSession {
  readonly map: MapDocument;
  readonly playerId: string;

  private readonly config: GameConfig;
  private readonly createSimulation: () => Promise<LocalSimulation>;
  private simulation: LocalSimulation | null = null;
  private accumulator = 0;
  private input: InputCommand = { move: { x: 0, y: 0 }, dash: false };
  private events: SimEvent[] = [];
  private runState: RunState = { phase: "live" };
  private lastSnapshot: GameSnapshot | null = null;

  constructor(options: LocalSessionOptions) {
    this.map = options.map;
    this.config = options.config;
    this.playerId = options.playerId;
    this.createSimulation = options.createSimulation ?? (() => DotBotSimulation.create({ map: this.map, config: this.config }));
  }

  async start(): Promise<void> {
    this.simulation = await this.createSimulation();
  }

  sendInput(input: InputCommand): void {
    this.input = { move: input.move, dash: false };
    // Hand the intent to the sim immediately so its own sticky Dash queue
    // retains a press even when this render frame does not produce a tick.
    // Subsequent ticks reapply movement with Dash false, matching the old
    // hook's once-per-press Dash clearing without adding a second queue.
    this.simulation?.applyInput(this.playerId, input);
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

  getRunState(): RunState {
    return this.runState;
  }

  giveUp(): void {
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
    this.events = [];
    this.runState = { phase: "live" };
    this.lastSnapshot = null;
  }

  private applyRunEvents(events: SimEvent[]): void {
    if (this.runState.phase === "over") return;
    for (const event of events) {
      if (event.botId !== this.playerId) continue;
      if (event.type === "extracted") {
        this.runState = { phase: "over", reason: "extracted", keptItems: event.items, lostItems: [], learnedBlueprints: [] };
        return;
      }
      if (event.type === "consumed") {
        this.runState = { phase: "over", reason: "died", keptItems: [], lostItems: event.lostItems, learnedBlueprints: [] };
        return;
      }
    }
  }
}
