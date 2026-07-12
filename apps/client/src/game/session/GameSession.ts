import type { GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";

export type RunState =
  | { phase: "live" }
  | { phase: "over"; reason: "extracted" | "died" | "timeout"; keptDots: number; lostDots: number };

export interface GameSession {
  readonly map: MapDocument;
  readonly playerId: string;
  /** Async init (Rapier load today; WS connect for M1's NetSession). */
  start(): Promise<void>;
  /** Latest input intent for the local player; called once per render frame. */
  sendInput(input: InputCommand): void;
  /**
   * Advance session time by elapsedMs and return the freshest snapshot to
   * render (null until start() resolves). LocalSession runs the fixed-step
   * accumulator here; a future NetSession will interpolate buffered server
   * snapshots instead.
   */
  update(elapsedMs: number): GameSnapshot | null;
  /** Events since last drain (manifest/UI consumption lands in M1). */
  drainEvents(): SimEvent[];
  /** Authoritative run outcome for this session implementation. */
  getRunState(): RunState;
  /** Debug instrumentation; optional so NetSession can no-op it. */
  setMeasuredFps?(fps: number): void;
  dispose(): void;
}
