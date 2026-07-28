import { describe, expect, it } from "vitest";
import { LIFT, MAX_BLOCK_LIFT, SHADOW_ALPHA, blockShadowRings } from "./tone";

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
