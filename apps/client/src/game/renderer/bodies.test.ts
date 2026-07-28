import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { CORE_REACH, PLATE_REACH, contactReach, platesForCount } from "@dotbot/game/shields";
import type { Vec2 } from "@dotbot/game/types";
import {
  drawBareEdges,
  drawBodyOutline,
  drawChargedCore,
  drawDashRing,
  drawInvulnerabilityRing,
  drawPlates,
  type OutlinedBody,
} from "./bodies";
import { SHADOW_ALLOWANCE, drawGroundShadow } from "./grounding";

/**
 * The one rule this file exists for: **nothing a bot draws may lie outside the
 * body a bot has.**
 *
 * `contactReach` is the body — the plate ring where a plate is up, the core where
 * one is gone — and it is what the attack test and the separation solver measure
 * against. Every mark the renderer makes is a claim about where that surface is,
 * and for a long time three of them lied by more than the physics ever did: a
 * broken plate still stroked its full arc at 22.5 where the body reaches 9.6, an
 * enemy's serration sat 1.5 units outside a fully plated hull, and the dash and
 * invulnerability rings were closed circles at the plain radius on a body with a
 * bite out of it. Two stripped bots at their legal 19.20 rest distance drew 25.8
 * units of ring through each other, each ring enclosing the other bot's centre.
 *
 * So the invariant is checked the only way it can be trusted: by running the
 * shipped drawing functions against a Graphics that records what they ask for,
 * for every plate state and a spread of facings, and measuring the ink.
 *
 * A stroke has width, and at the step where a plate is missing half of that width
 * necessarily hangs *over* the notch — there is no way to draw a line on a
 * discontinuity without it. That is the whole allowance, and it is angular: ink may
 * sit half a pen width to either side of a place the body reaches. It buys no
 * radial licence at all.
 */

// ---------------------------------------------------------------------------
// A Graphics that remembers what it was asked to draw
// ---------------------------------------------------------------------------

type Segment = { points: Vec2[]; whole?: boolean };

/** One painted mark: where the ink is, how wide the pen was, and how it corners. */
type Mark = { points: Vec2[]; width: number; join: string; whole: boolean };

const ARC_STEP = Math.PI / 360;

/**
 * Enough of Pixi's Graphics to record geometry: every path call appends points,
 * and `stroke`/`fill` closes the batch off with the pen width that painted it.
 *
 * Straight runs are recorded by their endpoints alone, which is exact — the
 * distance from the bot's centre along a segment is convex, so it peaks at an
 * end. Arcs are sampled at half a degree.
 */
class Recorder {
  readonly marks: Mark[] = [];
  private pending: Segment[] = [];
  private cursor: Vec2 | null = null;

  moveTo(x: number, y: number): this {
    this.cursor = { x, y };
    this.pending.push({ points: [{ x, y }] });
    return this;
  }

  lineTo(x: number, y: number): this {
    this.cursor = { x, y };
    this.current().points.push({ x, y });
    return this;
  }

  arc(cx: number, cy: number, radius: number, from: number, to: number, counter = false): this {
    const points: Vec2[] = [];
    const sweep = counter ? -Math.abs(to - from) : Math.abs(to - from);
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
    for (let step = 0; step <= steps; step += 1) {
      const angle = from + (sweep * step) / steps;
      points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
    this.current().points.push(...points);
    this.cursor = points[points.length - 1];
    return this;
  }

  circle(cx: number, cy: number, radius: number): this {
    this.pending.push({ points: [], whole: true });
    this.arc(cx, cy, radius, 0, Math.PI * 2);
    return this;
  }

  closePath(): this {
    return this;
  }

  beginPath(): this {
    return this;
  }

  stroke(style: { width?: number; join?: string }): this {
    // Pixi's own default join is a mitre, and a mitre is what pushes a corner's ink
    // out past the inset the rest of the stroke respects. Recorded, so the check
    // can charge for it.
    return this.paint(style.width ?? 1, style.join ?? "miter");
  }

  fill(): this {
    return this.paint(0, "miter");
  }

  private paint(width: number, join: string): this {
    for (const segment of this.pending) {
      if (segment.points.length > 0) {
        this.marks.push({ points: segment.points, width, join, whole: segment.whole === true });
      }
    }
    this.pending = [];
    this.cursor = null;
    return this;
  }

  private current(): Segment {
    if (this.pending.length === 0) this.pending.push({ points: this.cursor ? [this.cursor] : [] });
    return this.pending[this.pending.length - 1];
  }
}

function recorder(): Graphics & { marks: Mark[] } {
  return new Recorder() as unknown as Graphics & { marks: Mark[] };
}

// ---------------------------------------------------------------------------
// How far outside the body a point is
// ---------------------------------------------------------------------------

const RADIUS = 24;

function body(shieldSegments: number[], facing: number): OutlinedBody {
  return { position: { x: 0, y: 0 }, radius: RADIUS, facing, shieldSegments };
}

/**
 * How far the body reaches anywhere within `slack` radians of an angle.
 *
 * The reach is piecewise constant with cells two radians wide, so a window this
 * narrow straddles at most one step and its two ends carry both answers.
 */
function reachNear(bot: OutlinedBody, angle: number, slack: number): number {
  return Math.max(
    contactReach(bot.radius, bot.facing, bot.shieldSegments, angle - slack),
    contactReach(bot.radius, bot.facing, bot.shieldSegments, angle + slack),
  );
}

/** A direction change sharper than this is a join rather than the curve of an arc. */
const CORNER = 0.3;

function unit(from: Vec2, to: Vec2): Vec2 | null {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 1e-9) return null;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/**
 * How far past the body a mark's ink actually reaches.
 *
 * A stroke's width spreads *perpendicular to its own path*, which is the whole
 * subtlety and the reason a first attempt at this test passed a serration sitting
 * 1.5 units outside a plated hull. On an arc the perpendicular is radial, so the
 * ink runs half a pen width further out than the path — an arc at 24.5 with a
 * two-unit pen is ink at 25.5. On the radial cut edge at the step of a missing
 * plate the perpendicular is *tangential*, so the ink reaches no further out than
 * its endpoint, and what it does instead is hang half a pen width over the notch
 * — which no stroke drawn on a discontinuity can avoid, and is therefore allowed
 * as an angular slack rather than as radial licence.
 *
 * Round joins are the exception: at a corner the ink covers a disc, so the full
 * half width counts radially. That is why the silhouette strokes are inset by
 * exactly half their width and land on the surface rather than past it.
 */
function worstOverhang(
  bot: OutlinedBody,
  marks: Mark[],
  allowance = 0,
): { over: number; at: Vec2 | null } {
  let over = -Infinity;
  let at: Vec2 | null = null;

  for (const mark of marks) {
    for (let index = 0; index < mark.points.length; index += 1) {
      const point = mark.points[index];
      const radius = Math.hypot(point.x, point.y);
      if (radius < 1e-9) continue;
      const angle = Math.atan2(point.y, point.x);
      const join = mark.join;
      const back = index > 0 ? unit(mark.points[index - 1], point) : null;
      const forward = index + 1 < mark.points.length ? unit(point, mark.points[index + 1]) : null;
      const tangents = [back, forward].filter((value): value is Vec2 => value !== null);

      // No direction at all (a lone moveTo, or a zero-length run): treat the ink as
      // a round dab, which is the most it could be.
      let radialShare = 1;
      let tangentialShare = 1;
      if (tangents.length > 0) {
        const turn = tangents.length === 2
          ? Math.abs(Math.atan2(
            tangents[0].x * tangents[1].y - tangents[0].y * tangents[1].x,
            tangents[0].x * tangents[1].x + tangents[0].y * tangents[1].y,
          ))
          : 0;
        if (turn > CORNER) {
          /**
           * A round join keeps the corner's ink inside a disc of the half width, so
           * it costs exactly the inset. A mitre runs out along the bisector to
           * `pen / cos(turn / 2)` — 1.41 times the half width at a right angle,
           * which on the dash ring is two units of ink past the contact surface at
           * the one place the drawing is being made honest.
           */
          radialShare = join === "round" ? 1 : Math.min(10, 1 / Math.cos(turn / 2));
        } else {
          radialShare = 0;
          tangentialShare = 0;
          for (const tangent of tangents) {
            const along = tangent.x * point.x / radius + tangent.y * point.y / radius;
            radialShare = Math.max(radialShare, Math.sqrt(Math.max(0, 1 - along * along)));
            tangentialShare = Math.max(tangentialShare, Math.abs(along));
          }
        }
      }

      const pen = mark.width / 2;
      const ink = radius + pen * radialShare;
      const limit = reachNear(bot, angle, (pen * tangentialShare) / radius) + allowance;
      if (ink - limit > over) {
        over = ink - limit;
        at = point;
      }
    }
  }
  return { over: over === -Infinity ? 0 : over, at };
}

/** Every plate state a three-plate bot can be in, plus a bot with no plates. */
const STATES: number[][] = [
  [1, 1, 1],
  [1, 1, 0.5],
  [1, 1, 0],
  [1, 0.5, 0],
  [1, 0, 0],
  [0.5, 0, 0],
  [0, 0, 0],
  [],
];

const FACINGS = [0, 0.31, Math.PI / 3, Math.PI / 2, 2.4, Math.PI, -0.7, -2.9];

/** Every mark a standing bot makes, except the shadow, which has its own rule. */
function drawWholeBot(bot: OutlinedBody, serrated: boolean): Mark[] {
  const g = recorder();
  drawPlates(g, bot, 0xe03131, serrated);
  drawBodyOutline(g, bot);
  drawChargedCore(g, bot.position, bot.radius * CORE_REACH, 0.55, 0x14171a);
  drawBareEdges(g, bot, 0xe03131);
  drawDashRing(g, bot);
  drawInvulnerabilityRing(g, bot);
  return g.marks;
}

describe("the dash gauge", () => {
  /**
   * Liquid finds its own level, so the gauge reads against the world's down and not
   * the body's.
   *
   * The body is drawn once at facing 0 and its container spun by the caller, so a
   * gauge drawn in body-local space rides around with the bot: walk north and the
   * glass fills sideways, walk south and it fills from the top down. Reported from
   * play as "sometimes the gauge is filling up upside down and it looks odd", which
   * is exactly right — a mark that means "how much dash is left" cannot also encode
   * heading.
   *
   * Measured the way the eye reads it: the filled liquid's centre of area has to sit
   * BELOW the core's centre in world space, at every spin, because that is what
   * "half full" looks like. `drawChargedCore` is handed the spin its container is
   * about to apply, and the test applies that same spin to the recorded geometry.
   */
  const spun = (point: Vec2, spin: number): Vec2 => ({
    x: point.x * Math.cos(spin) - point.y * Math.sin(spin),
    y: point.x * Math.sin(spin) + point.y * Math.cos(spin),
  });

  /**
   * Stated as an equivalence rather than as a fact about the fill's shape, because
   * an equivalence needs nothing to identify which recorded mark is the liquid —
   * and picking it out by point count picks the empty glass instead, which is a
   * whole circle and is symmetric enough to satisfy any test about where its mass
   * sits. Which shape the fill takes is already pinned in bodyMarks.test.ts.
   *
   * The claim: whatever the core draws at a spin of `s`, rotated BY `s` — the
   * rotation its container is about to apply — lands exactly where the same core
   * drawn at rest does. That is what world-referenced means, and it covers the
   * waterline, the rim, and the catch light in one assertion.
   */
  it("lands in the same world place whichever way the body is pointing", () => {
    for (const charge of [0.15, 0.5, 0.85]) {
      const rest = recorder();
      drawChargedCore(rest, { x: 0, y: 0 }, 24 * CORE_REACH, charge, 0x14171a, 0);
      for (const spin of FACINGS) {
        const g = recorder();
        drawChargedCore(g, { x: 0, y: 0 }, 24 * CORE_REACH, charge, 0x14171a, spin);
        expect(g.marks.length, "same marks either way").toBe(rest.marks.length);
        for (let index = 0; index < g.marks.length; index += 1) {
          // A whole circle about the body's own centre is spin-invariant as a SHAPE
          // but not point for point: the arc sampler always starts at angle zero, so
          // spinning the drawing renumbers the rim. Nothing to check on those.
          if (g.marks[index].whole) continue;
          // Compared as a centroid rather than point for point, because the arc's
          // step count is `ceil(sweep / step)` and subtracting the spin from both
          // ends changes `sweep` in the last bit — 387 samples against 386, for the
          // same arc. The centroid does not care, and the bug moves it by ~3 units
          // against a tolerance of 0.01.
          const centre = (points: Vec2[]) => points.reduce(
            (total, point) => ({ x: total.x + point.x / points.length, y: total.y + point.y / points.length }),
            { x: 0, y: 0 },
          );
          const drawn = spun(centre(g.marks[index].points), spin);
          const expected = centre(rest.marks[index].points);
          expect(
            Math.hypot(drawn.x - expected.x, drawn.y - expected.y),
            `mark ${index}, charge ${charge}, spin ${spin.toFixed(2)}`,
          ).toBeLessThan(0.01);
        }
      }
    }
  });
});

describe("the drawn bot never leaves the body", () => {
  it("keeps every mark inside contactReach, for every plate state and facing", () => {
    for (const shields of STATES) {
      for (const facing of FACINGS) {
        for (const serrated of [false, true]) {
          const bot = body(shields, facing);
          const { over, at } = worstOverhang(bot, drawWholeBot(bot, serrated));
          expect(
            over,
            `[${shields.join(",")}] facing ${facing.toFixed(2)}${serrated ? " serrated" : ""}`
              + ` overhangs by ${over.toFixed(2)} at ${JSON.stringify(at)}`,
          ).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it("has teeth: the ghost plate ring it was built to catch fails it", () => {
    /**
     * The mark this whole pass deleted, drawn back by hand: a broken plate's arc
     * stroked at the plate radius, 21.5 with a two-unit pen, in an arc where the
     * body reaches 9.6. If the check above can be satisfied by a drawing that does
     * that, it is measuring nothing.
     */
    const bot = body([1, 1, 0], 0);
    const g = recorder();
    const span = Math.PI * (2 / 3) - 0.24;
    const start = bot.facing + (2 * Math.PI * 2) / 3 - span / 2;
    g.moveTo(Math.cos(start) * 21.5, Math.sin(start) * 21.5);
    g.arc(0, 0, 21.5, start, start + span).stroke({ width: 2 });
    // Ink at 22.5 against a body reaching 9.6: 12.9 units of pure invention.
    const { over } = worstOverhang(bot, g.marks);
    expect(over).toBeCloseTo(12.9, 1);
  });

  it("puts the plate ring's outer edge exactly on the contact surface", () => {
    // Not merely inside: a plated bot's silhouette *is* its plate, so the ink has
    // to reach 24.00 and stop. Anything less and bodies touch before they meet.
    const bot = body(platesForCount(3, 3), 0.4);
    const g = recorder();
    drawPlates(g, bot, 0xe03131, true);
    let furthest = 0;
    for (const mark of g.marks) {
      for (const point of mark.points) {
        furthest = Math.max(furthest, Math.hypot(point.x, point.y) + mark.width / 2);
      }
    }
    expect(furthest).toBeCloseTo(RADIUS * PLATE_REACH, 6);
  });

  it("draws the bite as the step it is, not as a ring", () => {
    /**
     * A broken plate's two cut edges run from the neighbouring plate's reach in to
     * the core, and nothing is drawn on the ring across the gap. The read comes
     * from the step; the step is where the body actually is.
     */
    const bot = body([1, 1, 0], 0);
    const g = recorder();
    drawPlates(g, bot, 0xe03131, false);
    const bare = (Math.PI * 4) / 3;
    const onTheRing = g.marks.some((mark) => mark.points.some((point) => {
      const radius = Math.hypot(point.x, point.y);
      const delta = Math.abs(Math.atan2(point.y, point.x) - bare) % (Math.PI * 2);
      return radius > RADIUS * CORE_REACH && Math.min(delta, Math.PI * 2 - delta) < 0.6;
    }));
    expect(onTheRing).toBe(false);

    // Two cut edges, each running the full depth of the bite: 24 to 9.6.
    const radial = g.marks.filter((mark) => mark.points.length === 2);
    expect(radial).toHaveLength(2);
    for (const edge of radial) {
      const [outer, inner] = edge.points.map((point) => Math.hypot(point.x, point.y));
      expect(outer).toBeCloseTo(RADIUS * PLATE_REACH - 0.5, 6);
      expect(inner).toBeCloseTo(RADIUS * CORE_REACH - 0.5, 6);
    }
  });

  it("draws no cut edge where two bare arcs meet", () => {
    // Nothing steps there, so there is nothing to draw. A bot with nothing left is
    // a core and a hull.
    const g = recorder();
    drawPlates(g, body([0, 0, 0], 1.1), 0xe03131, false);
    expect(g.marks).toHaveLength(0);
  });
});

/**
 * The shadow is measured differently, and has to be: it is a shape *shifted* along
 * the sun rather than a stroke laid on the surface, so offsetting it slides ink
 * from one angular sector into the next and a per-angle radial comparison would
 * charge the plated side's shade to the bare side's reach. What a shadow owes is a
 * distance — every part of it within `SHADOW_ALLOWANCE` of the body — so distance
 * to the body is what gets measured.
 */
function outsideBody(bot: OutlinedBody, point: Vec2): number {
  const plates = bot.shieldSegments.length;
  const step = (Math.PI * 2) / (plates || 1);
  let nearest = Infinity;

  for (let index = 0; index < (plates || 1); index += 1) {
    const center = bot.facing + index * step;
    const reach = contactReach(bot.radius, bot.facing, bot.shieldSegments, center);
    const radius = Math.hypot(point.x, point.y);
    const delta = Math.atan2(
      Math.sin(Math.atan2(point.y, point.x) - center),
      Math.cos(Math.atan2(point.y, point.x) - center),
    );
    if (plates === 0 || Math.abs(delta) <= step / 2) {
      nearest = Math.min(nearest, Math.max(0, radius - reach));
      continue;
    }
    // Outside this plate's wedge: the nearest part of it is one of its two spokes.
    for (const edge of [center - step / 2, center + step / 2]) {
      const along = Math.max(0, Math.min(reach, point.x * Math.cos(edge) + point.y * Math.sin(edge)));
      nearest = Math.min(nearest, Math.hypot(
        point.x - Math.cos(edge) * along,
        point.y - Math.sin(edge) * along,
      ));
    }
  }
  return nearest;
}

describe("the cast shadow", () => {
  it("stays within its declared penumbra of the body, at every plate state", () => {
    for (const shields of STATES) {
      for (const facing of FACINGS) {
        const bot = body(shields, facing);
        const g = recorder();
        drawGroundShadow(g, bot.position, bot);
        let furthest = 0;
        for (const mark of g.marks) {
          for (const point of mark.points) furthest = Math.max(furthest, outsideBody(bot, point));
        }
        expect(furthest, `[${shields.join(",")}] facing ${facing.toFixed(2)}`)
          .toBeLessThanOrEqual(SHADOW_ALLOWANCE);
      }
    }
  });

  it("recedes with the body rather than holding the plated radius", () => {
    const spread = (shields: number[]): number => {
      const bot = body(shields, 0);
      const g = recorder();
      drawGroundShadow(g, bot.position, bot);
      let furthest = 0;
      for (const mark of g.marks) {
        for (const point of mark.points) furthest = Math.max(furthest, Math.hypot(point.x, point.y));
      }
      return furthest;
    };
    /**
     * Plated: 24 × 0.82 = 19.68 of body, 8.8 of penumbra and 10.74 of sun throw,
     * so 39.22 at the faintest step. Bare: the same ramp off a 9.6 body, 27.42.
     * The old disc gave a stripped bot the plated number — which is how two of
     * them resting correctly at 19.20 put 20.16 units of full-strength shade
     * through each other.
     */
    expect(spread([1, 1, 1])).toBeCloseTo(39.22, 1);
    expect(spread([0, 0, 0])).toBeCloseTo(27.42, 1);
  });
});
