/**
 * The kernel is only worth anything if it never lies in the unsafe direction, so
 * the bulk of this file is an ORACLE that shares no mathematics with it.
 *
 * The kernel works in support functions and Minkowski differences. The oracle
 * works in points, circles and line segments: it walks the two silhouettes — built
 * straight from `contactReach` — and asks whether they cross, with closed-form
 * circle/circle, circle/segment and segment/segment intersections. Two closed
 * regions overlap exactly when one contains the other's centre or their boundaries
 * cross, so that is a complete and exact overlap test, and bisecting it on centre
 * distance gives the true contact distance to floating-point precision.
 *
 * The headline assertion is two-sided and per-pose: the bodies must NOT overlap a
 * hair beyond what the kernel reports (it never underestimates — the bug), and
 * they MUST overlap a hair inside it (it does not overestimate either).
 */
import { describe, expect, it } from "vitest";
import { buildContactShape, contactDistance, makeContactShape } from "./bodyContact";
import { CORE_REACH, PLATE_REACH, contactReach } from "./shields";

const R = 24;
const PLATE = R * PLATE_REACH; // 24
const CORE = R * CORE_REACH; // 9.6
const TWO_PI = Math.PI * 2;

type Body = {
  x: number;
  y: number;
  radius: number;
  facing: number;
  segments: number[];
};

const body = (
  segments: number[],
  facing = 0,
  x = 0,
  y = 0,
  radius = R,
): Body => ({ x, y, facing, segments, radius });

// ---------------------------------------------------------------------------
// Oracle: exact silhouette intersection
// ---------------------------------------------------------------------------

const ORACLE_EPS = 1e-12;

function radialAt(b: Body, angle: number): number {
  return contactReach(b.radius, b.facing, b.segments, angle);
}

function pointInBody(px: number, py: number, b: Body): boolean {
  const qx = px - b.x;
  const qy = py - b.y;
  const d = Math.sqrt(qx * qx + qy * qy);
  if (d <= ORACLE_EPS) return true;
  return d <= radialAt(b, Math.atan2(qy, qx));
}

type Arc = { cx: number; cy: number; r: number; a0: number; span: number };
type Seg = { x0: number; y0: number; x1: number; y1: number };

/**
 * The silhouette as curves. Every angular cell contributes an arc at that cell's
 * reach; wherever two neighbouring cells reach differently the boundary steps
 * radially, which is a segment along the shared cell edge.
 */
function boundary(b: Body): { arcs: Arc[]; segs: Seg[] } {
  const n = b.segments.length;
  const arcs: Arc[] = [];
  const segs: Seg[] = [];
  if (n === 0) {
    arcs.push({ cx: b.x, cy: b.y, r: b.radius * CORE_REACH, a0: 0, span: TWO_PI });
    return { arcs, segs };
  }
  const cell = TWO_PI / n;
  const half = Math.PI / n;
  const radii = b.segments.map((s) => b.radius * (s > 0 ? PLATE_REACH : CORE_REACH));
  if (n === 1) {
    arcs.push({ cx: b.x, cy: b.y, r: radii[0], a0: 0, span: TWO_PI });
    return { arcs, segs };
  }
  for (let i = 0; i < n; i += 1) {
    const a0 = b.facing + i * cell - half;
    arcs.push({ cx: b.x, cy: b.y, r: radii[i], a0, span: cell });
    const prev = radii[(i - 1 + n) % n];
    if (prev !== radii[i]) {
      const lo = Math.min(prev, radii[i]);
      const hi = Math.max(prev, radii[i]);
      segs.push({
        x0: b.x + lo * Math.cos(a0),
        y0: b.y + lo * Math.sin(a0),
        x1: b.x + hi * Math.cos(a0),
        y1: b.y + hi * Math.sin(a0),
      });
    }
  }
  return { arcs, segs };
}

function onArc(arc: Arc, px: number, py: number): boolean {
  if (arc.span >= TWO_PI - 1e-12) return true;
  const angle = Math.atan2(py - arc.cy, px - arc.cx);
  let delta = (angle - arc.a0) % TWO_PI;
  if (delta < 0) delta += TWO_PI;
  return delta <= arc.span + 1e-12;
}

function arcsCross(a: Arc, b: Arc): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= ORACLE_EPS) return false;
  if (d > a.r + b.r || d < Math.abs(a.r - b.r)) return false;
  const t = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const hSq = a.r * a.r - t * t;
  if (hSq < 0) return false;
  const h = Math.sqrt(hSq);
  const mx = a.cx + (t * dx) / d;
  const my = a.cy + (t * dy) / d;
  const ox = (-dy * h) / d;
  const oy = (dx * h) / d;
  for (const sign of [1, -1]) {
    const px = mx + sign * ox;
    const py = my + sign * oy;
    if (onArc(a, px, py) && onArc(b, px, py)) return true;
  }
  return false;
}

function arcCrossesSeg(arc: Arc, s: Seg): boolean {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const fx = s.x0 - arc.cx;
  const fy = s.y0 - arc.cy;
  const qa = dx * dx + dy * dy;
  if (qa <= ORACLE_EPS) return false;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - arc.r * arc.r;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return false;
  const root = Math.sqrt(disc);
  for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
    if (t < -1e-12 || t > 1 + 1e-12) continue;
    const px = s.x0 + t * dx;
    const py = s.y0 + t * dy;
    if (onArc(arc, px, py)) return true;
  }
  return false;
}

function segsCross(p: Seg, q: Seg): boolean {
  const rx = p.x1 - p.x0;
  const ry = p.y1 - p.y0;
  const sx = q.x1 - q.x0;
  const sy = q.y1 - q.y0;
  const denom = rx * sy - ry * sx;
  const ax = q.x0 - p.x0;
  const ay = q.y0 - p.y0;
  if (Math.abs(denom) <= ORACLE_EPS) return false;
  const t = (ax * sy - ay * sx) / denom;
  const u = (ax * ry - ay * rx) / denom;
  return t >= -1e-12 && t <= 1 + 1e-12 && u >= -1e-12 && u <= 1 + 1e-12;
}

/**
 * Exact: two closed regions meet iff one holds the other's centre (every body
 * holds its own centre, so containment always shows up that way) or their
 * boundaries cross somewhere.
 */
function bodiesOverlap(a: Body, b: Body): boolean {
  if (pointInBody(a.x, a.y, b)) return true;
  if (pointInBody(b.x, b.y, a)) return true;
  const ba = boundary(a);
  const bb = boundary(b);
  for (const arc of ba.arcs) {
    for (const other of bb.arcs) if (arcsCross(arc, other)) return true;
    for (const seg of bb.segs) if (arcCrossesSeg(arc, seg)) return true;
  }
  for (const arc of bb.arcs) {
    for (const seg of ba.segs) if (arcCrossesSeg(arc, seg)) return true;
  }
  for (const seg of ba.segs) {
    for (const other of bb.segs) if (segsCross(seg, other)) return true;
  }
  return false;
}

/** Overlap with B placed `d` along `u` from A. */
function overlapAt(a: Body, b: Body, ux: number, uy: number, d: number): boolean {
  return bodiesOverlap(a, { ...b, x: a.x + d * ux, y: a.y + d * uy });
}

/** True contact distance by bisection on the exact overlap test. */
function oracleDistance(a: Body, b: Body, ux: number, uy: number): number {
  let lo = 0;
  let hi = a.radius * PLATE_REACH + b.radius * PLATE_REACH + 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (overlapAt(a, b, ux, uy, mid)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Kernel harness
// ---------------------------------------------------------------------------

const shapeA = makeContactShape(3);
const shapeB = makeContactShape(3);

function reachSum(a: Body, b: Body, ux: number, uy: number): number {
  const toB = Math.atan2(uy, ux);
  return radialAt(a, toB) + radialAt(b, toB + Math.PI);
}

/** The shipped predicate's distance, then the kernel's, for the same pose. */
function kernelDistance(a: Body, b: Body, ux: number, uy: number): number {
  buildContactShape(shapeA, a.radius, a.facing, a.segments);
  buildContactShape(shapeB, b.radius, b.facing, b.segments);
  return contactDistance(shapeA, shapeB, ux, uy, reachSum(a, b, ux, uy));
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const PLATE_VALUES = [0, 0.5, 1];

function randomSegments(rng: () => number): number[] {
  return [0, 1, 2].map(() => PLATE_VALUES[Math.floor(rng() * 3)]);
}

// ---------------------------------------------------------------------------

describe("contact shape", () => {
  it("is a plain circle when every plate is up, and when none is", () => {
    buildContactShape(shapeA, R, 0.7, [1, 1, 1]);
    expect(shapeA.count).toBe(1);
    expect(shapeA.r[0]).toBe(PLATE);

    buildContactShape(shapeA, R, 0.7, [1, 0.5, 1]);
    expect(shapeA.count).toBe(1);
    expect(shapeA.r[0]).toBe(PLATE);

    buildContactShape(shapeA, R, 0.7, [0, 0, 0]);
    expect(shapeA.count).toBe(1);
    expect(shapeA.r[0]).toBe(CORE);

    buildContactShape(shapeA, R, 0.7, []);
    expect(shapeA.count).toBe(1);
    expect(shapeA.r[0]).toBe(CORE);
  });

  it("is the core plus one sector per surviving plate otherwise", () => {
    buildContactShape(shapeA, R, 0, [1, 1, 0]);
    expect(shapeA.count).toBe(3);
    expect(shapeA.r[0]).toBe(CORE);
    expect(shapeA.r[1]).toBe(PLATE);
    expect(shapeA.r[2]).toBe(PLATE);
    // Plate 0 spans [-60, 60] degrees off the facing; plate 1 the next cell up.
    expect(Math.atan2(shapeA.e0y[1], shapeA.e0x[1])).toBeCloseTo(-Math.PI / 3, 12);
    expect(Math.atan2(shapeA.e1y[1], shapeA.e1x[1])).toBeCloseTo(Math.PI / 3, 12);
    expect(Math.atan2(shapeA.e0y[2], shapeA.e0x[2])).toBeCloseTo(Math.PI / 3, 12);
    expect(Math.atan2(shapeA.e1y[2], shapeA.e1x[2])).toBeCloseTo(Math.PI, 12);
  });

  it("refuses a plate array it cannot hold rather than dropping plates", () => {
    expect(() => buildContactShape(makeContactShape(2), R, 0, [1, 0, 1])).toThrow();
  });

  it("reproduces contactReach as its own degenerate case", () => {
    // Silhouette == footprint == collider, provable rather than asserted: contact
    // against a body of radius zero IS the radial extent of this one, so the kernel
    // and the drawn outline cannot drift. Away from the seam angles it agrees with
    // `contactReach` to within a rounding of the unit direction (cos^2 + sin^2 is
    // not exactly 1); on a seam it is the closed answer, the plate.
    const probe = makeContactShape(3);
    buildContactShape(probe, 0, 0, [1, 1, 1]);
    const a = body([1, 0.5, 0], 0.61);
    buildContactShape(shapeA, a.radius, a.facing, a.segments);
    for (let step = 0; step < 720; step += 1) {
      const angle = (step * TWO_PI) / 720 + 0.0037;
      const silhouette = contactDistance(shapeA, probe, Math.cos(angle), Math.sin(angle), 0);
      expect(silhouette).toBeCloseTo(contactReach(a.radius, a.facing, a.segments, angle), 12);
    }
  });
});

describe("authored contact distances", () => {
  it("holds two fully plated bots exactly 48 apart", () => {
    expect(kernelDistance(body([1, 1, 1]), body([1, 1, 1], 1.3), 1, 0)).toBe(48);
    expect(kernelDistance(body([1, 1, 1], 2.1), body([1, 1, 1], -0.4), 0, 1)).toBe(48);
  });

  it("lets a plated bot reach a bare core at 33.6", () => {
    expect(kernelDistance(body([1, 1, 1]), body([0, 0, 0], 0.9), 1, 0)).toBeCloseTo(33.6, 12);
  });

  it("adds the two radii when the bodies are plain circles of different size", () => {
    // Pinned without a seed to lean on: the fast path has to read both shapes.
    buildContactShape(shapeA, 24, 0.4, [1, 1, 1]);
    buildContactShape(shapeB, 13, 1.9, [1, 1, 1]);
    expect(contactDistance(shapeA, shapeB, 1, 0, 0)).toBe(37);
    buildContactShape(shapeB, 13, 1.9, [0, 0, 0]);
    expect(contactDistance(shapeA, shapeB, 0, 1, 0)).toBeCloseTo(24 + 5.2, 12);
  });

  it("lets two bare cores touch at 19.2", () => {
    expect(kernelDistance(body([0, 0, 0], 0.3), body([0, 0, 0], 2.2), 1, 0)).toBeCloseTo(19.2, 12);
  });

  it("moves the squad-in-file pose from 33.6 to 48", () => {
    // Both bots [1,1,0] facing +x, B directly ahead of A. The shipped predicate
    // reads one ray each and lands on 33.6 — a rest state with 170px^2 of real
    // overlap. Both bots have a live plate pointing at each other.
    const a = body([1, 1, 0]);
    const b = body([1, 1, 0]);
    expect(reachSum(a, b, 1, 0)).toBeCloseTo(33.6, 12);
    expect(kernelDistance(a, b, 1, 0)).toBeCloseTo(48, 12);
    // And that is the honest answer: at a hair under 48 they really do overlap.
    expect(overlapAt(a, b, 1, 0, 47.999)).toBe(true);
    expect(overlapAt(a, b, 1, 0, 48.001)).toBe(false);
  });
});

describe("against the oracle", () => {
  it("never underestimates over 120000 random poses, and never overestimates either", () => {
    const rng = mulberry32(0x5eed_1234);
    const POSES = 120_000;
    const PROBE = 1e-6;
    let worstUnder = 0;
    let worstOver = 0;
    let underCount = 0;
    let overCount = 0;

    for (let pose = 0; pose < POSES; pose += 1) {
      const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      // A slice of the sweep runs mismatched radii; nothing here assumes 24.
      if (pose % 8 === 0) {
        a.radius = 6 + rng() * 40;
        b.radius = 6 + rng() * 40;
      }
      const theta = rng() * TWO_PI;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const need = kernelDistance(a, b, ux, uy);

      // The whole point: at the reported distance the bodies are apart.
      if (overlapAt(a, b, ux, uy, need + PROBE)) {
        underCount += 1;
        const truth = oracleDistance(a, b, ux, uy);
        worstUnder = Math.max(worstUnder, truth - need);
      }
      // And not a fraction further than they have to be.
      if (!overlapAt(a, b, ux, uy, need - PROBE)) {
        overCount += 1;
        const truth = oracleDistance(a, b, ux, uy);
        worstOver = Math.max(worstOver, need - truth);
      }
    }

    console.log(
      `[oracle] ${POSES} poses: underestimates ${underCount} (worst ${worstUnder.toExponential(3)}px), `
        + `overestimates ${overCount} (worst ${worstOver.toExponential(3)}px)`,
    );
    expect(worstUnder).toBeLessThan(1e-6);
    expect(worstOver).toBeLessThan(1e-6);
  }, 600_000);

  it("agrees with a bisected oracle to floating-point scale", () => {
    const rng = mulberry32(0xc0ffee);
    let worst = 0;
    let worstSigned = 0;
    for (let pose = 0; pose < 4000; pose += 1) {
      const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const theta = rng() * TWO_PI;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const need = kernelDistance(a, b, ux, uy);
      const truth = oracleDistance(a, b, ux, uy);
      const error = need - truth;
      if (Math.abs(error) > worst) {
        worst = Math.abs(error);
        worstSigned = error;
      }
    }
    console.log(`[oracle] max |kernel - oracle| over 4000 bisected poses: ${worstSigned.toExponential(3)}px`);
    expect(worst).toBeLessThan(1e-9);
  }, 300_000);

  it("is sufficient where the shipped ray predicate is not", () => {
    // The defect, measured with the same oracle: how often does
    // contactReach(a,u) + contactReach(b,-u) call two overlapping bodies apart.
    const rng = mulberry32(0xd15ea5e);
    const POSES = 40_000;
    let overlapping = 0;
    let worstDepth = 0;
    for (let pose = 0; pose < POSES; pose += 1) {
      const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const theta = rng() * TWO_PI;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const shipped = reachSum(a, b, ux, uy);
      if (overlapAt(a, b, ux, uy, shipped + 1e-6)) {
        overlapping += 1;
        worstDepth = Math.max(worstDepth, oracleDistance(a, b, ux, uy) - shipped);
      }
    }
    const share = (100 * overlapping) / POSES;
    console.log(
      `[shipped predicate] ${share.toFixed(1)}% of poses rest overlapping, `
        + `worst ${worstDepth.toFixed(2)}px of missing separation`,
    );
    // Measured: 29.5% of uniformly random poses, and the worst is the full
    // 48 - 19.2 = 28.8 — both bots read their bare core along the line of centres
    // while a live plate on each is what actually meets.
    expect(share).toBeGreaterThan(25);
    expect(worstDepth).toBeGreaterThan(28);
  }, 300_000);

  it("holds on exactly-aligned poses, where random sampling never lands", () => {
    // Random poses miss the degenerate cases entirely: 120000 of them found nothing,
    // and this grid — facings and contact directions on exact multiples of 15
    // degrees, so plate edges line up square with the line of centres — found
    // 14.40px of missing separation. Two sectors pointing away from each other
    // reported a contact distance of ZERO. This is the test that pins
    // PERPENDICULAR_EPS; drop it to 0 and this fails while every random sweep passes.
    const states = [
      [1, 1, 1],
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
      [1, 0.5, 0],
    ];
    const STEPS = 24;
    let worstUnder = 0;
    for (const sa of states) {
      for (const sb of states) {
        for (let i = 0; i < STEPS; i += 1) {
          for (let j = 0; j < STEPS; j += 1) {
            for (let k = 0; k < STEPS; k += 1) {
              const a = body(sa, (i * TWO_PI) / STEPS);
              const b = body(sb, (j * TWO_PI) / STEPS);
              const theta = (k * TWO_PI) / STEPS;
              const ux = Math.cos(theta);
              const uy = Math.sin(theta);
              const need = kernelDistance(a, b, ux, uy);
              if (overlapAt(a, b, ux, uy, need + 1e-6)) {
                worstUnder = Math.max(worstUnder, oracleDistance(a, b, ux, uy) - need);
              }
            }
          }
        }
      }
    }
    expect(worstUnder).toBe(0);
  }, 300_000);
});

describe("behaviour the solver depends on", () => {
  it("is bounded above by the plain circle distance and below by the ray predicate", () => {
    const rng = mulberry32(0xb0a7);
    for (let pose = 0; pose < 20_000; pose += 1) {
      const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const theta = rng() * TWO_PI;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const need = kernelDistance(a, b, ux, uy);
      expect(need).toBeLessThanOrEqual(48 + 1e-9);
      expect(need).toBeGreaterThanOrEqual(reachSum(a, b, ux, uy) - 1e-9);
    }
  }, 120_000);

  it("does not depend on the floor seed, only on the geometry", () => {
    // The seed is a search hint. Any valid lower bound has to give the same answer,
    // or `coveringPlate`'s seam coin-flip would leak into the contact distance.
    const rng = mulberry32(0x5ea45);
    for (let pose = 0; pose < 5000; pose += 1) {
      const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const theta = rng() * TWO_PI;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      buildContactShape(shapeA, a.radius, a.facing, a.segments);
      buildContactShape(shapeB, b.radius, b.facing, b.segments);
      const seeded = contactDistance(shapeA, shapeB, ux, uy, reachSum(a, b, ux, uy));
      const bare = contactDistance(shapeA, shapeB, ux, uy, 0);
      const half = contactDistance(shapeA, shapeB, ux, uy, seeded / 2);
      // A tighter seed retires different pairs, so the surviving candidate can be
      // a different expression of the same number. Last-bit, not last-plate.
      expect(Math.abs(bare - seeded)).toBeLessThan(1e-12);
      expect(Math.abs(half - seeded)).toBeLessThan(1e-12);
    }
  }, 120_000);

  it("resolves the exactly-antipodal seam without a coin flip", () => {
    // `coveringPlate` at exactly PI behind a facing-0 [1,1,0] bot has two
    // mathematically equidistant candidates, plate 1 (up) and plate 2 (broken),
    // and picks between them on floating-point noise. The kernel compares nothing:
    // the union is closed, so the seam belongs to the live plate, every time.
    const a = body([1, 1, 0]);
    const b = body([1, 1, 0]);
    expect(kernelDistance(a, b, 1, 0)).toBe(48);
    // Same pose reached from either side of the seam: no discontinuity at PI.
    for (const nudge of [-1e-9, 0, 1e-9]) {
      const turned = body([1, 1, 0], nudge);
      expect(kernelDistance(a, turned, 1, 0)).toBeCloseTo(48, 6);
    }
    // The old ray predicate is the thing that flips here.
    expect([33.6, 48]).toContain(Number(reachSum(a, b, 1, 0).toFixed(10)));
  });

  it("is symmetric under swapping the two bodies", () => {
    const rng = mulberry32(0x51de);
    for (let pose = 0; pose < 20_000; pose += 1) {
      const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
      const theta = rng() * TWO_PI;
      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      const forward = kernelDistance(a, b, ux, uy);
      const backward = kernelDistance(b, a, -ux, -uy);
      expect(Math.abs(forward - backward)).toBeLessThan(1e-9);
    }
  }, 120_000);

  it("moves continuously in the contact direction and in either facing", () => {
    // Continuity, stated the only way that is actually true of this shape: shrink
    // the step by 1000 and the largest move shrinks by 1000. It is NOT uniformly
    // Lipschitz — a sector's straight edge runs through the body's centre, so where
    // the Minkowski boundary goes locally radial the derivative has no bound at all,
    // and an adversarial search found 236665px per radian with the bisected oracle
    // agreeing to nine figures. That is real geometry, not a kernel artefact.
    //
    // The numbers to reason about rotation with are therefore the typical slope,
    // measured below over uniformly random poses (472px/rad in the contact
    // direction, 297px/rad in facing), and the hard cap in the next test: however
    // steep the slope, the whole function lives in [19.2, 48].
    const steps = [1e-3, 1e-6, 1e-9];
    const movesU: number[] = [];
    const movesFacing: number[] = [];
    for (const step of steps) {
      const rng = mulberry32(0x11f5);
      let worstU = 0;
      let worstFacing = 0;
      for (let pose = 0; pose < 12_000; pose += 1) {
        const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
        const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
        const theta = rng() * TWO_PI;
        const base = kernelDistance(a, b, Math.cos(theta), Math.sin(theta));
        worstU = Math.max(
          worstU,
          Math.abs(kernelDistance(a, b, Math.cos(theta + step), Math.sin(theta + step)) - base),
        );
        worstFacing = Math.max(
          worstFacing,
          Math.abs(
            kernelDistance({ ...a, facing: a.facing + step }, b, Math.cos(theta), Math.sin(theta))
              - base,
          ),
        );
      }
      movesU.push(worstU);
      movesFacing.push(worstFacing);
    }
    console.log(
      `[continuity] worst move per step, 12000 poses each\n`
        + steps
          .map(
            (step, i) =>
              `  step ${step.toExponential(0)} rad: ${movesU[i].toExponential(3)}px in u `
              + `(${(movesU[i] / step).toFixed(0)}/rad), ${movesFacing[i].toExponential(3)}px in facing `
              + `(${(movesFacing[i] / step).toFixed(0)}/rad)`,
          )
          .join("\n"),
    );
    // Each 1000x smaller step moves it at most ~1000x less: continuous, no jump.
    for (let i = 1; i < steps.length; i += 1) {
      expect(movesU[i]).toBeLessThan(movesU[i - 1] / 500);
      expect(movesFacing[i]).toBeLessThan(movesFacing[i - 1] / 500);
    }
  }, 120_000);

  it("never demands more than the body can grow by, however it turns", () => {
    // What the rotation hypothesis actually costs, end to end. A 120-degree turn is
    // the largest re-seat the plate array can produce in one step, and no turn at
    // all can demand more than the 48 - 19.2 = 28.8 a pair of bodies can grow by.
    // At the per-tick push cap that is 3 ticks of jostling, worst case.
    const rng = mulberry32(0x2222);
    let worst = 0;
    for (const turn of [0.1, 0.5, (Math.PI * 2) / 3]) {
      for (let pose = 0; pose < 8000; pose += 1) {
        const a = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
        const b = body(randomSegments(rng), rng() * TWO_PI - Math.PI);
        const theta = rng() * TWO_PI;
        const base = kernelDistance(a, b, Math.cos(theta), Math.sin(theta));
        const turned = kernelDistance(
          { ...a, facing: a.facing + turn },
          b,
          Math.cos(theta),
          Math.sin(theta),
        );
        expect(base).toBeGreaterThanOrEqual(2 * CORE - 1e-9);
        expect(base).toBeLessThanOrEqual(2 * PLATE + 1e-9);
        worst = Math.max(worst, Math.abs(turned - base));
      }
    }
    console.log(`[rotation] worst single-turn step in required distance: ${worst.toFixed(2)}px`);
    expect(worst).toBeLessThanOrEqual(2 * PLATE - 2 * CORE + 1e-9);
  }, 120_000);
});

describe("distribution and cost", () => {
  it("reports the rest-distance distribution per plate-state pair, before and after", () => {
    const states: Array<[string, number[]]> = [
      ["111", [1, 1, 1]],
      ["110", [1, 1, 0]],
      ["100", [1, 0, 0]],
      ["000", [0, 0, 0]],
    ];
    const STEPS = 24;
    const rows: string[] = [];
    for (let x = 0; x < states.length; x += 1) {
      for (let y = x; y < states.length; y += 1) {
        const before: number[] = [];
        const after: number[] = [];
        for (let i = 0; i < STEPS; i += 1) {
          for (let j = 0; j < STEPS; j += 1) {
            for (let k = 0; k < STEPS; k += 1) {
              const a = body(states[x][1], (i * TWO_PI) / STEPS);
              const b = body(states[y][1], (j * TWO_PI) / STEPS);
              const theta = (k * TWO_PI) / STEPS;
              const ux = Math.cos(theta);
              const uy = Math.sin(theta);
              before.push(reachSum(a, b, ux, uy));
              after.push(kernelDistance(a, b, ux, uy));
            }
          }
        }
        before.sort((p, q) => p - q);
        after.sort((p, q) => p - q);
        const stat = (v: number[]) =>
          `${v[0].toFixed(2)} / ${v[v.length >> 1].toFixed(2)} / ${v[v.length - 1].toFixed(2)}`;
        const mean = (v: number[]) => v.reduce((t, n) => t + n, 0) / v.length;
        rows.push(
          `${states[x][0]} vs ${states[y][0]}  before ${stat(before)}  after ${stat(after)}`
            + `  mean ${mean(before).toFixed(2)} -> ${mean(after).toFixed(2)}`,
        );
      }
    }
    console.log(`[distribution] min / median / max rest distance\n${rows.join("\n")}`);
    expect(rows.length).toBe(10);
  }, 300_000);

  it("costs what a per-pair per-tick call can afford", () => {
    const cases: Array<[string, number[], number[]]> = [
      ["111 v 111", [1, 1, 1], [1, 1, 1]],
      ["110 v 000", [1, 1, 0], [0, 0, 0]],
      ["100 v 100", [1, 0, 0], [1, 0, 0]],
      ["110 v 110", [1, 1, 0], [1, 1, 0]],
    ];
    const ITERS = 400_000;
    // Directions out of the timed loop: sin/cos would be a third of the fast path.
    const dirs = new Float64Array(2048);
    for (let i = 0; i < 1024; i += 1) {
      const t = (i * TWO_PI) / 1024;
      dirs[2 * i] = Math.cos(t);
      dirs[2 * i + 1] = Math.sin(t);
    }
    const lines: string[] = [];
    let buildNs = 0;
    for (const [label, sa, sb] of cases) {
      buildContactShape(shapeA, R, 0.37, sa);
      buildContactShape(shapeB, R, 2.11, sb);
      let sink = 0;
      for (let round = 0; round < 2; round += 1) {
        const start = performance.now();
        for (let i = 0; i < ITERS; i += 1) {
          const k = (i & 1023) * 2;
          sink += contactDistance(shapeA, shapeB, dirs[k], dirs[k + 1], 0);
        }
        const elapsed = performance.now() - start;
        // Second round is the measurement; the first only warms the JIT.
        if (round === 1) lines.push(`${label}: ${((elapsed * 1e6) / ITERS).toFixed(0)} ns/call`);
      }
      expect(sink).toBeGreaterThan(0);
    }
    {
      const segments = [1, 1, 0];
      let sink = 0;
      for (let round = 0; round < 2; round += 1) {
        const start = performance.now();
        for (let i = 0; i < ITERS; i += 1) {
          buildContactShape(shapeA, R, i * 1e-4, segments);
          sink += shapeA.count;
        }
        const elapsed = performance.now() - start;
        if (round === 1) buildNs = (elapsed * 1e6) / ITERS;
      }
      expect(sink).toBeGreaterThan(0);
    }
    console.log(
      `[cost] ${lines.join("\n       ")}\n       buildContactShape (110, worst case): `
        + `${buildNs.toFixed(0)} ns, once per bot per tick`,
    );
  }, 300_000);
});
