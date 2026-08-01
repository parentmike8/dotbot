import type { RunState } from "./session/GameSession";

/** A live state seen after this client has already rendered a run result can
 * only be a later matchStart on the same hot-arena session. */
export function startsNewRun(runEnded: boolean, state: RunState): boolean {
  return runEnded && state.phase === "live";
}

export function runGenerationAdvanced(previous: number | undefined, current: number | undefined): boolean {
  return previous !== undefined && current !== undefined && previous !== current;
}
