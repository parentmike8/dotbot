import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import type { Rect } from "@dotbot/game/types";
import {
  LIFT,
  MAT,
  MAX_BLOCK_LIFT,
  SHADOW_ALPHA,
  blockShadowRings,
  faceLight,
  shade,
  volume,
} from "./tone";

/**
 * The block shadow's ramp.
 *
 * These exist because of a bug that a screenshot found and no test could have:
 * `contact`'s nine steps were tuned at a wall's lift of 10, where the rings land
 * about a unit apart and disappear. Buildings later started scaling their lift
 * with storey count, and at Civic Tower's 101 the same nine steps were twelve
 * units apart — six concentric rounded rectangles stepping across the pavement.
 *
 * Nothing was wrong with the ramp. What was wrong is that a constant tuned at one
 * scale got reused at ten times that scale, silently. So the property under test
 * is not "the numbers are these numbers" but "the ramp stays smooth at any lift a
 * building can reach".
 */

/** Composite of overlapping layers: they multiply through, they do not add. */
function composite(alphas: number[]): number {
  return 1 - alphas.reduce((keep, alpha) => keep * (1 - alpha), 1);
}

/**
 * Enough of Pixi's Graphics to record what `volume` fills, in order.
 *
 * Deliberately smaller than the `Recorder` in modelWalls.test / modelStairs.test:
 * those need polygons, strokes and paths, and this only needs to know which
 * rectangles got which colour.
 */
function filler() {
  const fills: Array<Rect & { color: number }> = [];
  let pending: Rect | null = null;
  const g = {
    rect(x: number, y: number, w: number, h: number) {
      pending = { x, y, w, h };
      return g;
    },
    roundRect(x: number, y: number, w: number, h: number) {
      return g.rect(x, y, w, h);
    },
    fill(style: { color: number }) {
      if (pending) fills.push({ ...pending, color: style.color });
      pending = null;
      return g;
    },
    stroke() {
      pending = null;
      return g;
    },
  };
  return { g: g as unknown as Graphics, fills };
}

const NORTH = { x: 0, y: -1 };
const SOUTH = { x: 0, y: 1 };
const EAST = { x: 1, y: 0 };
const BOX: Rect = { x: 100, y: 200, w: 60, h: 40 };

describe("a solid's faces are lit by their own normals", () => {
  /**
   * The defect this pins, and why no screenshot could have caught it.
   *
   * `volume` flooded the footprint with `mat.front` and painted the top over it, so
   * the exposed band came out in the SOUTH tone wherever it ended up. While the pull
   * was always north that was invisible — the exposed band always WAS the south face.
   * The moment an object turned its top toward the camera, a box at the edge of view
   * showed a dark band on its NORTH side: a shadow on the lit side. That is the whole
   * reason object parallax shipped disabled.
   */

  it("darkens the band left on the south when the top is pulled north", () => {
    const { g, fills } = filler();
    volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, NORTH);
    expect(fills[0].color).toBe(shade(MAT.steelLit.top, faceLight(SOUTH)));
  });

  it("BRIGHTENS the band left on the north when the top is pulled south", () => {
    /**
     * The assertion that would have blocked the bug. A north-facing vertical surface
     * is square to the light, so it catches MORE of it than the horizontal top does —
     * `faceLight` at a north normal exceeds 1. Any implementation that reuses one
     * "front face" tone fails this, which is the point.
     */
    const { g, fills } = filler();
    volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, SOUTH);
    const band = fills[0];
    expect(band.color).toBe(shade(MAT.steelLit.top, faceLight({ x: 0, y: -1 })));
    expect(faceLight({ x: 0, y: -1 })).toBeGreaterThan(1);
    expect(band.y).toBeCloseTo(BOX.y, 6);
  });

  it("puts a west-facing tone on the band a rightward pull leaves behind", () => {
    // On an axis only one face shows, so the base fill is that face outright.
    const { g, fills } = filler();
    volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, EAST);
    expect(fills[0].color).toBe(shade(MAT.steelLit.top, faceLight({ x: -1, y: 0 })));
    expect(fills[0].w).toBeCloseTo(BOX.w, 6);
  });

  it("shows two differently-lit faces on an oblique pull", () => {
    /**
     * The case that only exists once the pull can leave north: pulled south-east, a
     * box shows its bright north face AND its west flank, and they cannot be the same
     * tone. The flank is painted over the base, which also settles the shared corner
     * in favour of the side actually turned toward the viewer.
     */
    const { g, fills } = filler();
    volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, { x: 0.7, y: 0.7 });
    const north = shade(MAT.steelLit.top, faceLight({ x: 0, y: -1 }));
    const west = shade(MAT.steelLit.top, faceLight({ x: -1, y: 0 }));
    expect(north).not.toBe(west);
    expect(fills[0].color).toBe(north);

    const flank = fills[1];
    expect(flank.color).toBe(west);
    expect(flank.x).toBeCloseTo(BOX.x, 6);
    // Never wider than the lift it stands for — a face, not an overhang.
    expect(flank.w).toBeLessThanOrEqual(LIFT.cabinet + 1e-6);
  });

  it("paints one fill per exposed face and no more", () => {
    // An axis pull exposes one face; the old code's flood-then-cover always cost two
    // fills plus the top, and repainting the same colour twice is how a hot path
    // quietly doubles its work across 31 objects a rebuild.
    const { g, fills } = filler();
    volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, NORTH);
    const bands = fills.filter((fill) => fill.color !== MAT.steelLit.top && fill.color !== MAT.steelLit.lit);
    expect(bands).toHaveLength(1);
  });

  it("no longer draws any face at the old rectangle-only front tone", () => {
    /**
     * `material()` built `front` at 0.68 while `faceLight` gives 0.536 at the same
     * normal, so every rectangle in the game had been drawing its front face a
     * quarter lighter than every polygon drew the identical face. This pins the
     * reconciliation rather than trusting it, in the direction chosen: onto the
     * darker physically-derived value, which reads as more solid.
     */
    expect(MAT.steelLit.front).not.toBe(shade(MAT.steelLit.top, faceLight(SOUTH)));
    for (const pull of [NORTH, SOUTH, EAST, { x: -1, y: 0 }]) {
      const { g, fills } = filler();
      volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, pull);
      expect(fills.map((fill) => fill.color)).not.toContain(MAT.steelLit.front);
    }
  });

  it("keeps every fill inside the authored footprint, at any pull", () => {
    // The silhouette rule still holds — height is taken inside the shape. A band
    // shaded by its own normal must not become an excuse to draw an overhang.
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2;
      const { g, fills } = filler();
      volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, { x: Math.cos(angle), y: Math.sin(angle) });
      for (const fill of fills) {
        expect(fill.x).toBeGreaterThanOrEqual(BOX.x - 1e-6);
        expect(fill.y).toBeGreaterThanOrEqual(BOX.y - 1e-6);
        expect(fill.x + fill.w).toBeLessThanOrEqual(BOX.x + BOX.w + 1e-6);
        expect(fill.y + fill.h).toBeLessThanOrEqual(BOX.y + BOX.h + 1e-6);
      }
    }
  });

  it("paints the lit top after every band, so detail lands on the top face", () => {
    /**
     * Three dozen call sites draw detail on the returned rect. If a band were painted
     * after the top, every one of them would be drawing under a side face.
     *
     * Not "the top is the last fill" — the north-edge catch light legitimately lands
     * after it. What must hold is that no BAND does.
     */
    const { g, fills } = filler();
    const top = volume(g, BOX, MAT.steelLit, LIFT.cabinet, 0, { x: 0.7, y: 0.7 });
    const topAt = fills.findIndex((fill) => fill.color === MAT.steelLit.top);
    expect(topAt).toBeGreaterThan(0);
    expect(fills[topAt].x).toBeCloseTo(top.x, 6);
    expect(fills[topAt].y).toBeCloseTo(top.y, 6);
    for (const after of fills.slice(topAt + 1)) {
      expect(after.color).toBe(MAT.steelLit.lit);
    }
  });
});

/** A one-storey shop, a mid-rise, a tower, and the tallest block that will draw. */
const LIFTS = [LIFT.wall * 2.4, 50, 101, MAX_BLOCK_LIFT];

describe("blockShadowRings", () => {
  it("casts nothing for something lying flat on the ground", () => {
    expect(blockShadowRings(0)).toEqual([]);
    expect(blockShadowRings(-5)).toEqual([]);
  });

  it("never leaves a step wide enough to see, at any lift", () => {
    // The whole bug in one assertion. A fixed step count passes this at lift 10
    // and fails it at lift 101, which is exactly what happened.
    for (const lift of LIFTS) {
      const rings = blockShadowRings(lift);
      for (let i = 1; i < rings.length; i += 1) {
        const gap = rings[i - 1].grow - rings[i].grow;
        expect(gap).toBeLessThanOrEqual(2.41);
      }
    }
  });

  it("reaches the same total darkness the nine-step ramp did", () => {
    /**
     * Load-bearing, and not obviously so. Every surface a shadow falls on had its
     * own tone picked by eye with this wash already sitting on it — a roof deck
     * most of all. A ramp that composites to a different total silently restyles
     * every building on the map.
     */
    const target = composite([...SHADOW_ALPHA]);
    for (const lift of LIFTS) {
      const rings = blockShadowRings(lift);
      expect(composite(rings.map((ring) => ring.alpha))).toBeCloseTo(target, 6);
    }
  });

  it("keeps the old ramp's falloff shape, not just its total", () => {
    /**
     * A uniform wash and a real penumbra composite to the same number at the
     * centre and look nothing alike, so the total alone is not enough.
     *
     * A point a quarter of the way out is darkened by every ring that still
     * reaches it — the *wide* ones, not the tight ones. Getting that backwards
     * still passes at a loose tolerance, which is why the expected value is taken
     * from the same end of the hand-tuned ramp rather than written down.
     */
    for (const at of [0.25, 0.5, 0.75]) {
      const old = composite(SHADOW_ALPHA.filter((_, index) => index / (SHADOW_ALPHA.length - 1) >= at));
      for (const lift of LIFTS) {
        const rings = blockShadowRings(lift);
        const reach = rings[0].grow;
        const covering = rings.filter((ring) => ring.grow >= reach * at);
        expect(composite(covering.map((ring) => ring.alpha))).toBeCloseTo(old, 1);
      }
    }
  });

  it("grows outward monotonically, darkest ring last", () => {
    // Drawn outermost first, so each ring lands on top of a larger one. Out of
    // order, the faint wide rings paint over the dark tight ones and the shadow
    // inverts into a halo with a hole in it.
    for (const lift of LIFTS) {
      const rings = blockShadowRings(lift);
      for (let i = 1; i < rings.length; i += 1) {
        expect(rings[i].grow).toBeLessThan(rings[i - 1].grow);
        expect(Math.hypot(rings[i].dx, rings[i].dy))
          .toBeLessThan(Math.hypot(rings[i - 1].dx, rings[i - 1].dy));
      }
    }
  });

  it("throws no more geometry at a shadow than it needs", () => {
    // The step count follows the spread, so a low block stays cheap. Unbounded,
    // a hundred-building map would pay thousands of fills for shadows nobody can
    // tell apart.
    expect(blockShadowRings(LIFT.wall * 2.4).length).toBeLessThan(20);
    expect(blockShadowRings(MAX_BLOCK_LIFT).length).toBeLessThanOrEqual(64);
  });

  it("saturates rather than banding, past the tallest block it will draw", () => {
    // The clamp has to hold the *shape*, not just the count. A ring cap would keep
    // the geometry cheap and quietly reintroduce the bands.
    const capped = blockShadowRings(MAX_BLOCK_LIFT);
    for (const absurd of [MAX_BLOCK_LIFT + 1, 400, 5000]) {
      expect(blockShadowRings(absurd)).toEqual(capped);
    }
  });

  it("ranks buildings: more lift reaches further and offsets further", () => {
    let previousReach = 0;
    let previousOffset = 0;
    for (const lift of LIFTS) {
      const outer = blockShadowRings(lift)[0];
      expect(outer.grow).toBeGreaterThan(previousReach);
      expect(Math.hypot(outer.dx, outer.dy)).toBeGreaterThan(previousOffset);
      previousReach = outer.grow;
      previousOffset = Math.hypot(outer.dx, outer.dy);
    }
  });
});
