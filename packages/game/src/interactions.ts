import { distance } from "./math";
import type { Vec2 } from "./types";

/**
 * Single source of truth for "can this bot channel on that downed body".
 * The server gates coverage on it and the client drives the verb UI from it,
 * so what the player is told matches what the simulation will accept.
 */
export function withinDownedCoverRange(
  actorPosition: Vec2,
  actorRadius: number,
  targetPosition: Vec2,
  targetRadius: number,
  minimumTolerance: number,
): boolean {
  const downedFootprintRadius = targetRadius * 0.55;
  return distance(actorPosition, targetPosition) <= Math.max(minimumTolerance, actorRadius + downedFootprintRadius);
}
