/**
 * Exact star-vs-star contact distance.
 *
 * `contactReach` answers one question — how far does this body reach *along one
 * ray*. Two bodies were then held apart with
 *
 *     dist >= contactReach(a, u) + contactReach(b, -u)
 *
 * and that predicate is only NECESSARY, never sufficient. A bot is not a circle;
 * it is a core disc with plate sectors bolted on, and sampling a single ray of a
 * notched star tells you nothing about the notch's neighbours. Measured over
 * random poses, 43.9% of them satisfy the ray test while the two bodies genuinely
 * intersect, by up to 19.2px. That is a stable, force-free, OVERLAPPING fixed
 * point for the separation solver, and it is the welding play reported. The
 * everyday squad-in-file pose — both bots `[1, 1, 0]` facing +x — rests at 33.60
 * with 170px^2 of real overlap; it wants 48.00.
 *
 * This module answers the sufficient question instead: the minimum centre
 * distance along a direction `u` at which the two bodies are just touching, so
 * that `dist >= contactDistance(...)` PROVES they are disjoint.
 *
 * How it works, in one paragraph. Two sets overlap at centre offset `c` exactly
 * when `c` lies in the Minkowski difference `A (+) (-B)`. Both bodies are unions
 * of convex primitives that all contain their own centre, so that difference is a
 * union of convex sets all containing the origin, and the answer is the largest
 * `t` with `t*u` inside it — the max over primitive pairs of each pair's radial
 * extent. For one convex `K` containing the origin the radial extent is
 * `min over n of h_K(n) / <u, n>`, and `h_K` is piecewise smooth in `n` with a
 * handful of breakpoints, so that minimum is found exactly by evaluating a finite
 * candidate list. Every step of that is one-sided in the safe direction: a
 * candidate list that missed the true minimiser would report a distance that is
 * too LARGE (a little extra spacing), never too small (the bug).
 *
 * Cost is a few dozen flops for the common case. Two fully plated bots are two
 * plain discs — which is exactly why this bug did not exist before plate reach
 * and core reach diverged.
 */

import { CORE_REACH, PLATE_REACH, coveringPlate } from "./shields";

const TWO_PI = Math.PI * 2;

const KIND_DISC = 0;
const KIND_SECTOR = 1;

/**
 * A bot's body decomposed into convex primitives, in body-local space with the
 * centre at the origin. Flat typed arrays and a reusable instance: this is built
 * once per bot per tick and read once per candidate pair, so the trig is amortised
 * and the hot path never allocates.
 *
 * Primitive 0 is always a disc. It is the whole body when every plate is up (a
 * fully plated bot is a circle) or when none is; otherwise it is the bare core and
 * primitives 1.. are the surviving plates as convex sectors with their apex at the
 * centre.
 */
export type ContactShape = {
  count: number;
  /** `KIND_DISC` or `KIND_SECTOR`, per primitive. */
  kind: Int8Array;
  /** Outer radius, per primitive. */
  r: Float64Array;
  /** Unit direction of a sector's first edge. Unused for a disc. */
  e0x: Float64Array;
  e0y: Float64Array;
  /** Unit direction of a sector's second edge, `2*PI/n` counter-clockwise of e0. */
  e1x: Float64Array;
  e1y: Float64Array;
  /** Authored plate represented by this primitive, or -1 for the core disc. */
  plate: Int8Array;
};

export type ContactFeature = {
  distance: number;
  /** Primitive on A that establishes first contact along the requested axis. */
  aPrimitive: number;
  /** Primitive on B that establishes first contact along the requested axis. */
  bPrimitive: number;
};

/** A reusable shape sized for a bot with at most `maxShields` plates. */
export function makeContactShape(maxShields: number): ContactShape {
  const capacity = Math.max(1, maxShields) + 1;
  return {
    count: 0,
    kind: new Int8Array(capacity),
    r: new Float64Array(capacity),
    e0x: new Float64Array(capacity),
    e0y: new Float64Array(capacity),
    e1x: new Float64Array(capacity),
    e1y: new Float64Array(capacity),
    plate: new Int8Array(capacity).fill(-1),
  };
}

/**
 * Rewrite `contactReach`'s region as a set union. This is not a new shape and it
 * is not an approximation of one: `contactReach` assigns every angle to its
 * nearest plate centre, so the plate cells tile the circle edge to edge with no
 * gap, and the body is exactly
 *
 *     core disc  U  one full-cell sector per surviving plate.
 *
 * Any live plate is a plate, exactly as `contactReach` treats it. This used to say "a cracked
 * plate (0.5) is a plate", from when a hit on bare body could half-break one; plates are now
 * whole or gone, so the distinction has nothing left to describe.
 *
 * The one place the two disagree is a hair's breadth wide and deliberate. On the
 * seam angle exactly between a live plate and a dead one, `contactReach` picks a
 * winner by comparing two floating-point distances that are mathematically equal —
 * a coin flip. The union is closed, so it always answers with the plate. That
 * makes this function the larger of the two on a measure-zero set, which is the
 * safe side, and unlike `coveringPlate` it is not a coin flip: it does not compare
 * anything.
 */
export function buildContactShape(
  out: ContactShape,
  radius: number,
  facing: number,
  segments: readonly number[],
): void {
  const n = segments.length;
  if (n + 1 > out.kind.length) {
    throw new Error(`ContactShape holds ${out.kind.length - 1} plates, got ${n}`);
  }

  let allIntact = n > 0;
  for (let index = 0; index < n; index += 1) {
    if (segments[index] <= 0) {
      allIntact = false;
      break;
    }
  }

  if (n === 0 || allIntact) {
    out.count = 1;
    out.kind[0] = KIND_DISC;
    out.r[0] = radius * (allIntact ? PLATE_REACH : CORE_REACH);
    out.plate[0] = -1;
    return;
  }

  out.kind[0] = KIND_DISC;
  out.r[0] = radius * CORE_REACH;
  out.plate[0] = -1;

  const cell = TWO_PI / n;
  const half = Math.PI / n;
  let count = 1;
  for (let index = 0; index < n; index += 1) {
    if (segments[index] <= 0) continue;
    // cell <= PI for n >= 2, so the sector is convex. n === 1 cannot reach here:
    // one plate is either up (allIntact) or down (all broken).
    const a0 = facing + index * cell - half;
    const a1 = a0 + cell;
    out.kind[count] = KIND_SECTOR;
    out.r[count] = radius * PLATE_REACH;
    out.e0x[count] = Math.cos(a0);
    out.e0y[count] = Math.sin(a0);
    out.e1x[count] = Math.cos(a1);
    out.e1y[count] = Math.sin(a1);
    out.plate[count] = index;
    count += 1;
  }
  out.count = count;
}

/**
 * Support of primitive `k` in unit direction `n`: how far the primitive extends
 * onto `n`. A disc gives its radius from anywhere. A sector gives its radius if
 * `n` points into the wedge, otherwise whichever outer corner leans furthest onto
 * `n` — or zero, which is the apex, when both lean away.
 */
function support(s: ContactShape, k: number, nx: number, ny: number): number {
  const r = s.r[k];
  if (s.kind[k] === KIND_DISC) return r;
  const e0x = s.e0x[k];
  const e0y = s.e0y[k];
  const e1x = s.e1x[k];
  const e1y = s.e1y[k];
  if (e0x * ny - e0y * nx >= 0 && nx * e1y - ny * e1x >= 0) return r;
  const d0 = e0x * nx + e0y * ny;
  const d1 = e1x * nx + e1y * ny;
  const lean = d0 > d1 ? d0 : d1;
  return lean > 0 ? r * lean : 0;
}

/**
 * A candidate normal must be off `u`'s perpendicular by more than this to be
 * trusted. Both are unit, so `<u, n>` is a cosine and this is an angle.
 *
 * Not a fudge — two things break down at the perpendicular. A normal exactly
 * perpendicular to `u` constrains nothing (the ray never leaves that half-plane)
 * and gives 0/0; the case is reached whenever a plate edge lines up square with
 * the line of centres, which authored, axis-aligned poses do constantly. And the
 * division amplifies the support's ~1e-15 rounding by `1/<u,n>`, so a candidate
 * scraping the perpendicular carries more error than answer. Discarding one costs
 * at most the pair's circle bound, `r_i + r_j`, which is always a safe distance;
 * keeping one cost 14.40px of missing separation on an exactly-aligned sweep, with
 * two sectors pointing away from each other reporting a contact distance of zero.
 */
const PERPENDICULAR_EPS = 1e-7;

/**
 * One candidate bound on the pair's radial extent: `h_K(n) / <u, n>`, where
 * `K = A_i (+) (-B_j)`. Valid — an upper bound on the extent — for ANY `n` on
 * `u`'s side, which is what makes the candidate search fail safe.
 */
function ratio(
  a: ContactShape,
  i: number,
  b: ContactShape,
  j: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
): number {
  const un = ux * nx + uy * ny;
  if (un <= PERPENDICULAR_EPS) return Number.POSITIVE_INFINITY;
  return (support(a, i, nx, ny) + support(b, j, -nx, -ny)) / un;
}

/**
 * The interior critical point of the ratio on a piece where one primitive
 * supports on its round side (a constant `c`) and the other at a corner `v`.
 * There `h_K(n) = c + <v, n>`, which is the support of the disc centred on `v`
 * with radius `c`, so the boundary of `K` is locally that circle and the critical
 * point is where the ray from the origin along `u` leaves it — one sqrt.
 *
 * The normal is re-derived from the hit point and fed back through `ratio`, which
 * uses the TRUE support. So guessing the wrong piece cannot break anything: a
 * wrong guess lands on a normal where the real `h_K` is larger, the ratio comes
 * out too high, and the caller's `min` throws it away.
 */
function circleCritical(
  a: ContactShape,
  i: number,
  b: ContactShape,
  j: number,
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  c: number,
): number {
  const uv = ux * vx + uy * vy;
  const discriminant = uv * uv - (vx * vx + vy * vy) + c * c;
  if (discriminant < 0) return Number.POSITIVE_INFINITY;
  const t = uv + Math.sqrt(discriminant);
  if (t <= 0) return Number.POSITIVE_INFINITY;
  const px = t * ux - vx;
  const py = t * uy - vy;
  const length = Math.sqrt(px * px + py * py);
  if (length <= 0) return Number.POSITIVE_INFINITY;
  return ratio(a, i, b, j, ux, uy, px / length, py / length);
}

/**
 * Radial extent of `A_i (+) (-B_j)` along `u`: the largest centre distance at
 * which those two primitives still touch.
 *
 * `min over n with <u,n> > 0 of h_K(n) / <u,n>`, evaluated at the finite set that
 * provably contains the minimiser: every breakpoint of `h_K` (`u` itself, plus the
 * four normals bounding each sector's support regions) and every interior critical
 * point. Returns early once the running minimum can no longer beat `best`, since
 * the body-level answer is a max over pairs.
 */
function pairExtent(
  a: ContactShape,
  i: number,
  b: ContactShape,
  j: number,
  ux: number,
  uy: number,
  best: number,
): number {
  // Both primitives round: K is a disc and the extent is the plain sum. Also the
  // breakpoint that covers every "one round side, one apex" piece.
  let psi = ratio(a, i, b, j, ux, uy, ux, uy);
  if (psi <= best) return psi;

  const aSector = a.kind[i] === KIND_SECTOR;
  const bSector = b.kind[j] === KIND_SECTOR;

  if (aSector) {
    const e0x = a.e0x[i];
    const e0y = a.e0y[i];
    const e1x = a.e1x[i];
    const e1y = a.e1y[i];
    // Where A_i's support switches feature: onto each edge, and off each corner.
    let candidate = ratio(a, i, b, j, ux, uy, e0x, e0y);
    if (candidate < psi) psi = candidate;
    candidate = ratio(a, i, b, j, ux, uy, e1x, e1y);
    if (candidate < psi) psi = candidate;
    candidate = ratio(a, i, b, j, ux, uy, e0y, -e0x);
    if (candidate < psi) psi = candidate;
    candidate = ratio(a, i, b, j, ux, uy, -e1y, e1x);
    if (candidate < psi) psi = candidate;
    if (psi <= best) return psi;
    // A_i on a corner, B_j on its round side.
    const r = a.r[i];
    const c = b.r[j];
    candidate = circleCritical(a, i, b, j, ux, uy, r * e0x, r * e0y, c);
    if (candidate < psi) psi = candidate;
    candidate = circleCritical(a, i, b, j, ux, uy, r * e1x, r * e1y, c);
    if (candidate < psi) psi = candidate;
    if (psi <= best) return psi;
  }

  if (bSector) {
    // B is reflected into the difference, so every one of its directions flips.
    const e0x = b.e0x[j];
    const e0y = b.e0y[j];
    const e1x = b.e1x[j];
    const e1y = b.e1y[j];
    let candidate = ratio(a, i, b, j, ux, uy, -e0x, -e0y);
    if (candidate < psi) psi = candidate;
    candidate = ratio(a, i, b, j, ux, uy, -e1x, -e1y);
    if (candidate < psi) psi = candidate;
    candidate = ratio(a, i, b, j, ux, uy, -e0y, e0x);
    if (candidate < psi) psi = candidate;
    candidate = ratio(a, i, b, j, ux, uy, e1y, -e1x);
    if (candidate < psi) psi = candidate;
    if (psi <= best) return psi;
    const r = b.r[j];
    const c = a.r[i];
    candidate = circleCritical(a, i, b, j, ux, uy, -r * e0x, -r * e0y, c);
    if (candidate < psi) psi = candidate;
    candidate = circleCritical(a, i, b, j, ux, uy, -r * e1x, -r * e1y, c);
    if (candidate < psi) psi = candidate;
  }

  return psi;
}

/**
 * The centre distance along unit direction `u` (pointing from A to B) at which
 * these two bodies are exactly touching. `dist >= contactDistance(...)` proves
 * they are disjoint; anything less is a real overlap.
 *
 * `floor` seeds the search with a distance already known to be reachable, so pairs
 * that cannot beat it are skipped. `contactReach(a, u) + contactReach(b, -u)` is
 * the natural seed and is always valid — it is the pair of surface points on the
 * line of centres — and so is 0. A seed that is NOT a lower bound is a lie and
 * will be returned unchanged.
 */
export function contactDistance(
  a: ContactShape,
  b: ContactShape,
  ux: number,
  uy: number,
  floor = 0,
): number {
  return contactKernel(a, b, ux, uy, floor);
}

export type ContactBody = {
  position: { x: number; y: number };
  radius: number;
  facing: number;
  shieldSegments: readonly number[];
};

/**
 * Exact authored-body overlap for privacy/presentation paths outside the hot
 * simulation loop.
 *
 * Do not replace this with a sum of two `contactReach` samples. That predicate
 * is only a lower bound for notched, partially plated bodies and can report
 * daylight while their neighbouring plate sectors genuinely overlap. The
 * simulation caches these shapes; low-frequency interest, renderer, and replay
 * admission can afford to build them and must share the same answer.
 */
export function bodiesTouching(a: ContactBody, b: ContactBody, epsilon = 0): boolean {
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const centres = Math.hypot(dx, dy);
  if (centres <= epsilon) return true;
  const aShape = makeContactShape(a.shieldSegments.length);
  const bShape = makeContactShape(b.shieldSegments.length);
  buildContactShape(aShape, a.radius, a.facing, a.shieldSegments);
  buildContactShape(bShape, b.radius, b.facing, b.shieldSegments);
  return centres <= contactDistance(aShape, bShape, dx / centres, dy / centres) + epsilon;
}

/**
 * Exact contact distance plus the two primitives that establish it.
 *
 * Damage uses the witness on the target to answer the physical question the
 * centre-angle shortcut could not: did the attacking body first touch the bare
 * core, or the SIDE of a surviving plate? A glancing body is finite, so its edge
 * can meet a plate even when the line between centres points through a broken
 * sector. Returning the same witness used by separation keeps collision and
 * damage on one geometry.
 */
export function contactFeature(
  a: ContactShape,
  b: ContactShape,
  ux: number,
  uy: number,
  floor = 0,
): ContactFeature {
  const feature: ContactFeature = { distance: floor, aPrimitive: 0, bPrimitive: 0 };
  feature.distance = contactKernel(a, b, ux, uy, floor, feature);
  return feature;
}

/**
 * Which surviving plate on A physically establishes contact with B, or null
 * when B reaches A's core first. `u` points from A toward B.
 */
export function contactingPlate(
  a: ContactShape,
  aFacing: number,
  aSegments: readonly number[],
  b: ContactShape,
  ux: number,
  uy: number,
): number | null {
  if (aSegments.length === 0 || aSegments.every((plate) => plate <= 0)) return null;
  if (aSegments.every((plate) => plate > 0)) {
    return coveringPlate(aFacing, aSegments.length, Math.atan2(uy, ux));
  }
  const witness = contactFeature(a, b, ux, uy);
  const plate = a.plate[witness.aPrimitive];
  return plate >= 0 && aSegments[plate] > 0 ? plate : null;
}

/** Allocation-free kernel for the separation hot path; witness is opt-in. */
function contactKernel(
  a: ContactShape,
  b: ContactShape,
  ux: number,
  uy: number,
  floor: number,
  feature?: ContactFeature,
): number {
  // Two fully plated bots, and any pair of bare cores: plain circles, plain sum.
  // The overwhelmingly common case, so it never touches the general machinery.
  if (a.count === 1 && b.count === 1) {
    const sum = a.r[0] + b.r[0];
    if (feature) {
      feature.aPrimitive = 0;
      feature.bPrimitive = 0;
    }
    return sum > floor ? sum : floor;
  }

  let best = floor;
  let bestA = 0;
  let bestB = 0;
  const aCount = a.count;
  const bCount = b.count;

  // Descending upper bound: a pair can never exceed r_i + r_j, so taking the
  // widest pairs first lets the prune below retire the rest immediately.
  // Sector x sector, then sector x core, then core x core.
  for (let i = 1; i < aCount; i += 1) {
    for (let j = 1; j < bCount; j += 1) {
      if (a.r[i] + b.r[j] <= best) continue;
      const psi = pairExtent(a, i, b, j, ux, uy, best);
      if (psi > best) {
        best = psi;
        bestA = i;
        bestB = j;
      }
    }
  }
  for (let i = 1; i < aCount; i += 1) {
    if (a.r[i] + b.r[0] <= best) continue;
    const psi = pairExtent(a, i, b, 0, ux, uy, best);
    if (psi > best) {
      best = psi;
      bestA = i;
      bestB = 0;
    }
  }
  for (let j = 1; j < bCount; j += 1) {
    if (a.r[0] + b.r[j] <= best) continue;
    const psi = pairExtent(a, 0, b, j, ux, uy, best);
    if (psi > best) {
      best = psi;
      bestA = 0;
      bestB = j;
    }
  }
  // Core against core, which is a disc against a disc and needs no search.
  const cores = a.r[0] + b.r[0];
  if (cores > best) {
    best = cores;
    bestA = 0;
    bestB = 0;
  }

  if (feature) {
    feature.aPrimitive = bestA;
    feature.bPrimitive = bestB;
  }
  return best;
}
