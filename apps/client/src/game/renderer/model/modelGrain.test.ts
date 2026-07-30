import { describe, expect, it } from "vitest";
import {
  SURFACE_GRAIN_ALPHA,
  SURFACE_GRAIN_DOTS,
  SURFACE_GRAIN_TILE,
  surfaceGrainEnabled,
  surfaceGrainSamples,
} from "./modelGrain";

describe("surface grain", () => {
  it("is deterministic, sparse, low-alpha, and contained by its tile", () => {
    const samples = surfaceGrainSamples();
    expect(samples).toEqual(surfaceGrainSamples());
    expect(samples).toHaveLength(SURFACE_GRAIN_DOTS);
    expect(SURFACE_GRAIN_ALPHA).toBeLessThan(0.5);
    for (const sample of samples) {
      expect(sample.x).toBeGreaterThanOrEqual(0);
      expect(sample.x).toBeLessThan(SURFACE_GRAIN_TILE);
      expect(sample.y).toBeGreaterThanOrEqual(0);
      expect(sample.y).toBeLessThan(SURFACE_GRAIN_TILE);
      expect(sample.alpha).toBeLessThanOrEqual(0.04);
      expect(sample.radius).toBeLessThanOrEqual(1.2);
    }
  });

  it("stays off unless a measured review explicitly opts in", () => {
    expect(surfaceGrainEnabled("")).toBe(false);
    expect(surfaceGrainEnabled("?grain=1")).toBe(true);
    expect(surfaceGrainEnabled("?grain=0")).toBe(false);
  });
});
