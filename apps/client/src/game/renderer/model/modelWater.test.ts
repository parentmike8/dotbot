import { describe, expect, it } from "vitest";
import { worldMap } from "@dotbot/game/content/world";
import { buildWaterSurfaces, driftWater } from "./modelWater";

/**
 * The surface moves, and it moves the way ambient motion is supposed to.
 *
 * Worth testing rather than eyeballing for one reason above the others: the whole claim of
 * `docs/world-motion.md` is that ambient motion costs nothing because the GEOMETRY IS BUILT
 * ONCE and only container transforms change per frame. That is a claim about code, and a
 * still screenshot cannot check it — the way this stops being true is somebody reaching for
 * `g.clear()` in a later pass, which these assertions would survive and the look would not.
 */
describe("water that breathes", () => {
  const built = () => buildWaterSurfaces(worldMap);

  it("gives every body two highlight layers under one mask", () => {
    const { surfaces, view } = built();
    expect(surfaces.length).toBeGreaterThan(0);
    for (const surface of surfaces) expect(surface.layers).toHaveLength(2);
    // One masked holder per layer, and every holder actually masked: an unmasked layer
    // would drift its streaks out over the bank.
    expect(view.children.length).toBe(surfaces.length * 2);
    for (const holder of view.children) expect(holder.mask).not.toBeNull();
  });

  it("moves the layers as time passes", () => {
    const { surfaces } = built();
    const layer = surfaces[0].layers[0];
    driftWater(surfaces, 0, false);
    const first = { x: layer.position.x, y: layer.position.y, alpha: layer.alpha };
    driftWater(surfaces, 1400, false);
    expect({ x: layer.position.x, y: layer.position.y }).not.toEqual({ x: first.x, y: first.y });
    expect(layer.alpha).not.toBe(first.alpha);
  });

  /** Undulating, not sliding: at any instant the two layers are somewhere different. */
  it("never has both layers at the same offset", () => {
    const { surfaces } = built();
    for (const at of [0, 700, 1900, 3300, 5000, 8800]) {
      driftWater(surfaces, at, false);
      const [a, b] = surfaces[0].layers;
      expect(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)).toBeGreaterThan(0.5);
    }
  });

  it("keeps the drift inside its stated amplitude, so a streak cannot leave the pool", () => {
    const { surfaces } = built();
    for (let at = 0; at < 20_000; at += 137) {
      driftWater(surfaces, at, false);
      for (const surface of surfaces) {
        for (const layer of surface.layers) {
          expect(Math.abs(layer.position.x)).toBeLessThanOrEqual(7);
          expect(Math.abs(layer.position.y)).toBeLessThanOrEqual(7);
          // Never invisible: at zero the highlight pops out of existence rather than fading.
          expect(layer.alpha).toBeGreaterThan(0.5);
        }
      }
    }
  });

  /** Two pools on one sheet must not undulate in lockstep. */
  it("gives each body its own phase", () => {
    const { surfaces } = built();
    if (surfaces.length < 2) return;
    expect(surfaces[0].phase).not.toBe(surfaces[1].phase);
  });

  it("parks everything at rest for reduced motion", () => {
    const { surfaces } = built();
    driftWater(surfaces, 4200, true);
    for (const surface of surfaces) {
      for (const layer of surface.layers) {
        expect(layer.position.x).toBe(0);
        expect(layer.position.y).toBe(0);
        expect(layer.alpha).toBe(1);
      }
    }
  });
});
