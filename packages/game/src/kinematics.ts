import { separateCircleFromRect } from "./collision";
import type { Rect, Vec2 } from "./types";

/**
 * Shared kinematic movement for bots. The server simulation and the client
 * predictor both integrate through these functions, so a predicted path and
 * the authoritative path only diverge on information the client cannot have
 * (hits, other players' inputs) — never on integration mechanics.
 *
 * Bots deliberately do not live in the physics solver: solver contacts gave
 * unbounded shoves, deep interpenetration, and (via a Rapier disabled-collider
 * quirk) pushable corpses. Circles vs axis-aligned rects plus a capped
 * shoulder-past rule is the whole game, and it stays deterministic.
 */

/** Largest single integration step: comfortably below half a thin wall, so a
 * dashing bot can never cross a wall's midline in one resolve. */
const MAX_SUBSTEP_PX = 6;

export function integrateWithWalls(
  position: Vec2,
  velocity: Vec2,
  dtMs: number,
  radius: number,
  solids: readonly Rect[],
): Vec2 {
  const totalPx = (Math.hypot(velocity.x, velocity.y) * dtMs) / 1000;
  if (totalPx === 0) {
    return { ...position };
  }
  const substeps = Math.max(1, Math.ceil(totalPx / MAX_SUBSTEP_PX));
  const stepMs = dtMs / substeps;
  // Collide-and-slide: on contact, the into-obstacle velocity component is
  // clipped and the tangential remainder carries into later substeps — flat
  // faces block cleanly, angled faces and corners deflect the way the old
  // contact solver did, without its unbounded impulses.
  let live = { ...velocity };
  let current = { ...position };
  for (let index = 0; index < substeps; index += 1) {
    const attempted = {
      x: current.x + (live.x * stepMs) / 1000,
      y: current.y + (live.y * stepMs) / 1000,
    };
    const resolved = resolveAgainstSolids(attempted, radius, solids);
    const pushX = resolved.x - attempted.x;
    const pushY = resolved.y - attempted.y;
    const pushLen = Math.hypot(pushX, pushY);
    if (pushLen > 0.0001) {
      const nx = pushX / pushLen;
      const ny = pushY / pushLen;
      const into = live.x * nx + live.y * ny;
      if (into < 0) {
        live = { x: live.x - into * nx, y: live.y - into * ny };
      }
    }
    current = resolved;
  }
  return current;
}

/** Iterative circle-vs-rect resolution; three passes settle every corner case
 * the maps produce (the flood-grid validation keeps geometry honest). */
export function resolveAgainstSolids(position: Vec2, radius: number, solids: readonly Rect[]): Vec2 {
  let current = position;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    let moved = false;
    for (const rect of solids) {
      const next = separateCircleFromRect(current, radius, rect);
      if (next.x !== current.x || next.y !== current.y) {
        current = next;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  return current;
}

/**
 * How far ONE side of an overlapping pair yields this tick. Soft and capped:
 * bots shoulder past each other instead of trading solver impulses, and a
 * standing bot can never be bulldozed across the map.
 */
export function separationPush(
  self: Vec2,
  selfRadius: number,
  other: Vec2,
  otherRadius: number,
  maxPushPx: number,
): Vec2 {
  const dx = self.x - other.x;
  const dy = self.y - other.y;
  const dist = Math.hypot(dx, dy);
  const overlap = selfRadius + otherRadius - dist;
  if (overlap <= 0) {
    return { x: 0, y: 0 };
  }
  // Perfectly stacked centers resolve along a fixed axis so both bots (and
  // the client predictor) agree on the direction deterministically.
  const nx = dist > 0.001 ? dx / dist : 1;
  const ny = dist > 0.001 ? dy / dist : 0;
  const push = Math.min(overlap / 2, maxPushPx);
  return { x: nx * push, y: ny * push };
}
