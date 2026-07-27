import { describe, expect, it } from "vitest";
import { perspectiveDotGeometry } from "./dotArt";

describe("pixel-city Dot geometry", () => {
  it("raises the icon above a grounded orb without changing the authored center", () => {
    const geometry = perspectiveDotGeometry({ x: 100, y: 200 }, 18);
    expect(geometry.iconCenter).toEqual({ x: 100, y: 196.4 });
    expect(geometry.orbCenterY).toBeCloseTo(198.56);
    expect(geometry.shadowY).toBeCloseTo(212.96);
    expect(geometry.orbRadiusY).toBeLessThan(geometry.orbRadiusX);
  });
});
