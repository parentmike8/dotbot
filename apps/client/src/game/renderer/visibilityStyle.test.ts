import { describe, expect, it } from "vitest";
import { visibilityFogStyle } from "./visibilityStyle";

describe("visibilityFogStyle", () => {
  it("uses the same strong hidden-space treatment across Pixel City", () => {
    expect(visibilityFogStyle("pixel-city", false)).toEqual(
      visibilityFogStyle("pixel-city", true),
    );
    expect(visibilityFogStyle("pixel-city", false)).toEqual({
      color: 0x090c12,
      alpha: 0.62,
    });
  });

  it("preserves the quieter plan-map treatments", () => {
    expect(visibilityFogStyle("plan", true).alpha).toBe(0.18);
    expect(visibilityFogStyle("plan", false).alpha).toBe(0.035);
  });
});
