import { distance } from "./math";
import type { Vec2 } from "./types";

/**
 * Center-to-center reach at which the visible bot and interaction-dot circles
 * first overlap. The bot radius is its outer gameplay footprint (and already
 * contains the rendered shield plates), so touching any part of that footprint
 * starts the channel instead of requiring the dot to sit inside the core.
 */
export function interactionDotReach(botRadius: number, dotRadius: number): number {
  return Math.max(0, botRadius) + Math.max(0, dotRadius);
}

export function withinInteractionDotRange(
  botPosition: Vec2,
  botRadius: number,
  dotPosition: Vec2,
  dotRadius: number,
): boolean {
  return distance(botPosition, dotPosition) <= interactionDotReach(botRadius, dotRadius);
}

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
