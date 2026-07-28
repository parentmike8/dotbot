import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { CORE_REACH, PLATE_REACH, contactReach } from "@dotbot/game/shields";
import type { Vec2 } from "@dotbot/game/types";
import {
  SHADOW_ALLOWANCE,
  SHADOW_PENUMBRA,
  drawCatchLight,
  drawGroundShadow,
  silhouetteCells,
  type SilhouetteBody,
} from "./grounding";

const RADIUS = 24;
const FACINGS = [0, 0.4, Math.PI / 2, 2.2, Math.PI, -1.3, -2.7];

function bot(shieldSegments: number[], facing = 0): SilhouetteBody {
  return { radius: RADIUS, facing, shieldSegments };
}

/**
 * Enough of Graphics to record where a fill or a mark was asked for. Only the
 * circle-and-arc calls the grounding primitives make.
 */
function recorder(): Graphics & { points: Vec2[]; groups: Vec2[][] } {
  const points: Vec2[] = [];
  /** One entry per paint call, so a single step of the shadow ramp can be read. */
  const groups: Vec2[][] = [];
  let batch: Vec2[] = [];
  const paint = () => {
    if (batch.length > 0) groups.push(batch);
    batch = [];
    return g;
  };
  const g = {
    points,
    groups,
    moveTo(x: number, y: number) {
      points.push({ x, y });
      batch.push({ x, y });
      return g;
    },
    lineTo(x: number, y: number) {
      points.push({ x, y });
      batch.push({ x, y });
      return g;
    },
    arc(cx: number, cy: number, radius: number, from: number, to: number) {
      const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 180)));
      for (let step = 0; step <= steps; step += 1) {
        const angle = from + ((to - from) * step) / steps;
        const at = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
        points.push(at);
        batch.push(at);
      }
      return g;
    },
    circle(cx: number, cy: number, radius: number) {
      return g.arc(cx, cy, radius, 0, Math.PI * 2);
    },
    closePath: () => g,
    beginPath: () => g,
    stroke: paint,
    fill: paint,
  };
  return g as unknown as Graphics & { points: Vec2[]; groups: Vec2[][] };
}

/**
 * Where a mark sits, as the centre of its bounding box.
 *
 * Deliberately not the centroid of the sample points: an arc is sampled per
 * degree and its endpoints land in two cells at once, so a point-mean carries a
 * few thousandths of sampling bias that turns with the shape. A bounding box is
 * insensitive to how the arc was walked.
 */
function place(points: Vec2[]): Vec2 {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** What a container rotation does to a point drawn in body-local space. */
function spun(point: Vec2, spin: number): Vec2 {
  const cos = Math.cos(spin);
  const sin = Math.sin(spin);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

describe("silhouetteCells", () => {
  it("is one cell per plate, each at that plate's own reach", () => {
    const cells = silhouetteCells(bot([1, 1, 0], 0.5));
    expect(cells).toHaveLength(3);
    expect(cells.map((cell) => cell.radius)).toEqual([
      RADIUS * PLATE_REACH,
      RADIUS * PLATE_REACH,
      RADIUS * CORE_REACH,
    ]);
    // Voronoi cells, not the plate glyph's span: a seam between two live plates is
    // a drawing gap, not a way in, so the cells have to tile the full circle.
    for (let index = 0; index < cells.length; index += 1) {
      expect(cells[index].to).toBeCloseTo(cells[(index + 1) % 3].from + (index === 2 ? Math.PI * 2 : 0), 9);
    }
  });

  it("agrees with contactReach at every angle, for every plate state", () => {
    const states = [[1, 1, 1], [1, 1, 0], [1, 0, 0], [0, 0, 0], [1, 0.5, 0], []];
    for (const shields of states) {
      for (const facing of FACINGS) {
        const body = bot(shields, facing);
        const cells = silhouetteCells(body);
        // Off the boundaries themselves: a cell edge belongs to whichever side
        // `coveringPlate` breaks the tie toward, which is its business, not the
        // silhouette's.
        for (let angle = -Math.PI + 0.005; angle < Math.PI; angle += 0.01) {
          const inside = cells.find((cell) => {
            const delta = Math.atan2(
              Math.sin(angle - (cell.from + cell.to) / 2),
              Math.cos(angle - (cell.from + cell.to) / 2),
            );
            return Math.abs(delta) < (cell.to - cell.from) / 2 - 1e-9;
          });
          expect(inside?.radius, `[${shields.join(",")}] at ${angle.toFixed(2)}`)
            .toBeCloseTo(contactReach(RADIUS, facing, shields, angle), 9);
        }
      }
    }
  });

  it("turns a plain circle into a single cell when a bot has no plates at all", () => {
    const cells = silhouetteCells(bot([], 1));
    expect(cells).toHaveLength(1);
    expect(cells[0].radius).toBeCloseTo(RADIUS * CORE_REACH, 9);
    expect(cells[0].to - cells[0].from).toBeCloseTo(Math.PI * 2, 9);
  });

  it("passes each reach through the caller's adjustment", () => {
    const cells = silhouetteCells(bot([1, 1, 0], 0), (reach) => reach - 1.5);
    expect(cells[0].radius).toBeCloseTo(22.5, 9);
    expect(cells[1].radius).toBeCloseTo(22.5, 9);
    expect(cells[2].radius).toBeCloseTo(8.1, 9);
  });
});

describe("one light", () => {
  /**
   * `tone.ts` rule 1: everything in this world is lit from one direction. The bot
   * layer was the thing breaking it. A body is drawn once at facing 0 and its
   * container is spun by the facing, so a sun baked as literal local coordinates
   * orbits its own bot: the shadow's centroid rode a 5.07-unit circle and a
   * half-turn dragged the whole cast 21.49 units sideways. On an AI bot re-facing
   * every tick in a clump that is a grey blob whipping around — renderer jitter
   * perfectly correlated with rotation, on ticks when the solver moved nobody.
   *
   * A fully plated bot is a circle, so its shadow must land in exactly the same
   * world place at every facing. That is the test.
   */
  it("keeps a plated bot's shadow in the same world place at every facing", () => {
    const places = FACINGS.map((facing) => {
      const g = recorder();
      // Exactly as the game draws it: shape at facing 0, spin says what the
      // container will do.
      drawGroundShadow(g, { x: 0, y: 0 }, bot([1, 1, 1], 0), { spin: facing });
      return place(g.points.map((point) => spun(point, facing)));
    });
    for (const at of places) {
      expect(at.x).toBeCloseTo(places[0].x, 3);
      expect(at.y).toBeCloseTo(places[0].y, 3);
    }
    // And it is genuinely offset, or the test would pass on a shadow with no sun.
    expect(Math.hypot(places[0].x, places[0].y)).toBeGreaterThan(2);
  });

  it("keeps the catch light in the same world place at every facing", () => {
    const places = FACINGS.map((facing) => {
      const g = recorder();
      drawCatchLight(g, { x: 0, y: 0 }, 9.6, 0.34, facing);
      return place(g.points.map((point) => spun(point, facing)));
    });
    for (const at of places) {
      expect(at.x).toBeCloseTo(places[0].x, 6);
      expect(at.y).toBeCloseTo(places[0].y, 6);
    }
    // Up and to the left, where the world's light comes from.
    expect(places[0].x).toBeLessThan(0);
    expect(places[0].y).toBeLessThan(0);
  });

  it("spins the shape with the bot even while the sun stays put", () => {
    // The other half of the same rule: the shadow is the *body's* shape, so the
    // bite has to point where the bot points.
    /**
     * The darkest step alone. The faint outer steps are thrown up to 10.74 units
     * along the sun, which is more than enough to fill the bite back in from the
     * side — real of a real penumbra, and useless for measuring a shape. At the
     * contact step the throw is 2.48 against a 12-unit step between plate and core.
     */
    const trace = (facing: number): Vec2[] => {
      const g = recorder();
      drawGroundShadow(g, { x: 0, y: 0 }, bot([1, 1, 0], 0), { spin: facing });
      return g.groups.slice(0, 3).flat().map((point) => spun(point, facing));
    };
    const ahead = trace(0);
    const turned = trace(Math.PI);
    const near = (point: Vec2, angle: number): boolean => {
      const delta = Math.atan2(point.y, point.x) - angle;
      return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) < 0.2;
    };
    const reach = (points: Vec2[], angle: number): number => Math.max(
      ...points.filter((point) => near(point, angle)).map((point) => Math.hypot(point.x, point.y)),
    );
    // Plate 2 is the broken one, centred 240 degrees off the facing, so the shallow
    // side of the shadow has to be 240 degrees off the facing too — at 240 pointing
    // one way and at 60 after a half turn.
    const bite = (Math.PI * 4) / 3;
    expect(reach(ahead, bite)).toBeLessThan(reach(ahead, 0));
    expect(reach(turned, bite + Math.PI)).toBeLessThan(reach(turned, Math.PI));
    // Comparing the two runs at the *same* world angle would prove nothing either
    // way: the sun throws the shade out on its own side and pulls it in on the
    // other, so the two sides are not interchangeable even on a plated bot.
  });
});

describe("the shadow's declared allowance", () => {
  it("is the penumbra plus the sun's throw, and nothing hidden", () => {
    expect(SHADOW_PENUMBRA).toBeCloseTo(8.8, 9);
    expect(SHADOW_ALLOWANCE).toBeCloseTo(19.54, 2);
  });

  it("is what a plated bot's shadow actually uses, to the unit", () => {
    const g = recorder();
    drawGroundShadow(g, { x: 0, y: 0 }, bot([1, 1, 1], 0));
    const furthest = Math.max(...g.points.map((point) => Math.hypot(point.x, point.y)));
    // 19.68 of body (24 × 0.82) plus the whole allowance.
    expect(furthest).toBeCloseTo(RADIUS * 0.82 + SHADOW_ALLOWANCE, 1);
  });
});
