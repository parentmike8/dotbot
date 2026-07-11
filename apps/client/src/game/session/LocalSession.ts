import { DotBotSimulation } from "@dotbot/game/simulation";
import type { GameConfig, GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";
import type { GameSession } from "./GameSession";

export type LocalSessionOptions = {
  map: MapDocument;
  config: GameConfig;
  playerId: string;
};

export class LocalSession implements GameSession {
  readonly map: MapDocument;
  readonly playerId: string;

  private readonly config: GameConfig;
  private simulation: DotBotSimulation | null = null;
  private accumulator = 0;
  private input: InputCommand = { move: { x: 0, y: 0 }, dash: false };

  constructor(options: LocalSessionOptions) {
    this.map = options.map;
    this.config = options.config;
    this.playerId = options.playerId;
  }

  async start(): Promise<void> {
    this.simulation = await DotBotSimulation.create({
      map: this.map,
      config: this.config,
    });
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
      this.accumulator -= tickSeconds;
    }

    return simulation.getSnapshot();
  }

  drainEvents(): SimEvent[] {
    return this.simulation?.drainEvents() ?? [];
  }

  setMeasuredFps(fps: number): void {
    this.simulation?.setMeasuredFps(fps);
  }

  dispose(): void {
    this.simulation?.dispose();
    this.simulation = null;
    this.accumulator = 0;
  }
}
