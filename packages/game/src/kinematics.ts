import { separateCircleFromSolid } from "./geometry";
import { nearbySolids, type SolidSource } from "./solidIndex";
import type { Rect, Solid, Vec2 } from "./types";

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

/**
 * World collision takes a plain radius, deliberately, and the reason is worth
 * keeping.
 *
 * Contact between *bots* follows the plates: a bot reaches its full radius where
 * a plate is up and only its core where one is gone. Threading that same
 * direction-dependent reach through here was the obvious next step and it was
 * wrong, because a bot's facing changes every frame with its movement direction.
 * Press a broken side against a wall at a reach of 9.6, turn sixty degrees, and a
 * live plate now points at that wall with a reach of 24 — the bot is suddenly
 * fourteen units inside the wall and gets ejected. Bot separation caps its push
 * per tick; this does not, and must not, or bodies would sit embedded in walls.
 *
 * Growing is what ejects. Shrinking never can. So callers pass the reach that
 * only shrinks on a discrete event — losing the last plate — and never changes
 * because a bot turned. A stripped bot still closes on a tree until its core
 * touches, which is the case that motivated the whole rule.
 */

export function integrateWithWalls(
  position: Vec2,
  velocity: Vec2,
  dtMs: number,
  radius: number,
  source: SolidSource,
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
    const resolved = resolveAgainstSolids(attempted, radius, source);
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

/**
 * Iterative circle-vs-solid resolution; three passes settle every corner case the
 * maps produce (the flood-grid validation keeps geometry honest).
 *
 * The single chokepoint for movement collision, shared by the server simulation
 * and client prediction, so both stay in lockstep by construction. Takes `Solid`s
 * so a wall may be a rect, a capsule at any angle, or a convex hull.
 */
export function resolveAgainstSolids(position: Vec2, radius: number, source: SolidSource): Vec2 {
  // Narrowed once, not per iteration: the slack in `nearbySolids` covers however
  // far separation moves the circle, and re-querying mid-loop would make the
  // candidate set depend on intermediate state.
  const solids = nearbySolids(source, position, radius);
  let current = position;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    let moved = false;
    for (const solid of solids) {
      const next = separateCircleFromSolid(current, radius, solid);
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

/** How many headings coincident pairs are spread over. Eight is enough that a
 * stack of spawns fans out instead of extruding into a single line, and small
 * enough that the choice stays legible in a log. */
const COINCIDENT_AXIS_COUNT = 8;

/**
 * FNV-1a over a string. Any stable hash would do; this one is short, has no
 * dependencies, and stays inside 32 bits via `Math.imul`, so the server and the
 * client compute the identical number — the only property anything here needs from
 * it. Two sides of a wire have to derive the same arbitrary-but-stable value from
 * the same id.
 */
export function stableHash(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pairHash(first: string, second: string): number {
  // Length-prefixed so ("ab", "c") and ("a", "bc") cannot collide.
  return stableHash(`${first.length}:${first}${second}`);
}

/**
 * Which way `selfId` goes when two bodies share a centre exactly.
 *
 * There is no centre line to push along at distance zero, so one has to be
 * invented, and the invented one has to be ANTI-SYMMETRIC: `separationPush` is
 * called once per body with the arguments swapped, and a fallback of a fixed
 * `(1, 0)` handed BOTH calls the same heading. The pair then translated in
 * lockstep at the full cap, welded, forever — reachable from spawn, from
 * `placeBot`'s independent x/y clamps, from revive placement and from knockback,
 * so not a theoretical case.
 *
 * Sorting the ids picks the heading and the id order picks the sign, so the two
 * calls are exact opposites and both the server and the predictor derive the
 * same answer from nothing but the two ids.
 */
export function coincidentSeparationAxis(selfId: string, otherId: string): Vec2 {
  if (selfId === otherId) {
    return { x: 1, y: 0 };
  }
  const ordered = selfId < otherId;
  const index = pairHash(ordered ? selfId : otherId, ordered ? otherId : selfId) % COINCIDENT_AXIS_COUNT;
  const angle = (index * Math.PI * 2) / COINCIDENT_AXIS_COUNT;
  const sign = ordered ? 1 : -1;
  return { x: Math.cos(angle) * sign, y: Math.sin(angle) * sign };
}

/** Unit vector pointing from `other` to `self`, or `fallback` when the two
 * centres coincide. The one place the degenerate case is decided. */
export function separationAxis(self: Vec2, other: Vec2, fallback: Vec2): Vec2 {
  const dx = self.x - other.x;
  const dy = self.y - other.y;
  const dist = Math.hypot(dx, dy);
  return dist > 0.001 ? { x: dx / dist, y: dy / dist } : { x: fallback.x, y: fallback.y };
}

/**
 * How far ONE side of an overlapping pair yields this tick. Capped, and
 * weighted by responsibility: the MOVER yields, a standing bot is an anchor
 * (yieldFraction 0) — bodies feel firm, and nobody gets bulldozed off a loot
 * channel by an AI shoulder.
 *
 * `requiredGap` is ONE distance for the pair, not two radii to add up. That is
 * not a tidier signature, it is the correction: bots are star-shaped, so the
 * distance at which two of them touch is a property of the PAIR — of both
 * facings, both plate arrays and the direction between them at once — and it does
 * not decompose into a reach per body. Adding two per-body reaches is exactly the
 * predicate that welded bodies together, because it samples a single ray of a
 * notched star and misses every plate either side of the notch. `contactDistance`
 * in bodyContact.ts is where the real number comes from.
 *
 * `fallbackAxis` only matters at coincident centres; pass
 * `coincidentSeparationAxis(selfId, otherId)` so the pair's two calls disagree
 * about direction the way two bodies must.
 */
export function separationPush(
  self: Vec2,
  other: Vec2,
  requiredGap: number,
  maxPushPx: number,
  yieldFraction: number,
  fallbackAxis: Vec2,
): Vec2 {
  const dist = Math.hypot(self.x - other.x, self.y - other.y);
  const overlap = requiredGap - dist;
  if (overlap <= 0 || yieldFraction <= 0) {
    return { x: 0, y: 0 };
  }
  const axis = separationAxis(self, other, fallbackAxis);
  const push = Math.min(overlap * yieldFraction, maxPushPx);
  return { x: axis.x * push, y: axis.y * push };
}

/** Distance from a point to the segment [a, b]; the swept contact test for a
 * fast mover is this against the victim's center, minus the radii. */
export function pointSegmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq < 0.000001) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq));
  return Math.hypot(point.x - (a.x + abx * t), point.y - (a.y + aby * t));
}
