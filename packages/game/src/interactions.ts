import { distance } from "./math";
import type { DotBotEntity, Vec2 } from "./types";

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

type BodyReach = Pick<DotBotEntity, "id" | "squadId" | "state" | "position" | "radius" | "floorId">;

/**
 * Is this body open to that bot's hands right now?
 *
 * A searched body stays open, so a taker who steps away and comes back does not
 * channel again — but it is only open to a rival. You do not take from your own
 * squad; you pick them up.
 *
 * The same predicate gates the simulation, the picker UI, and which inventories
 * cross the wire, so the client can never show a slot the server will refuse.
 */
export function canTakeFromBody(
  actor: BodyReach,
  body: BodyReach & Pick<DotBotEntity, "searched">,
  minimumTolerance: number,
): boolean {
  return actor.id !== body.id
    && actor.state === "alive"
    && bodyContentsPublic(body)
    && actor.squadId !== body.squadId
    && actor.floorId === body.floorId
    && withinDownedCoverRange(actor.position, actor.radius, body.position, body.radius, minimumTolerance);
}

/** A searched body's contents are known to everyone: it is lying open on the floor. */
export function bodyContentsPublic(body: Pick<DotBotEntity, "state" | "searched">): boolean {
  return body.state === "downed" && body.searched;
}
