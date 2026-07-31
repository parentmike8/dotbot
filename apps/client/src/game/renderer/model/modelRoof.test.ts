import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { roofParallax } from "./modelRoof";

describe("roof parallax strength", () => {
  it("scales the roof displacement without changing its direction", () => {
    const building = downtownMap.buildings[0];
    const centre = {
      x: building.footprint.x + building.footprint.w / 2,
      y: building.footprint.y + building.footprint.h / 2,
    };
    const camera = { x: centre.x - 400, y: centre.y + 300 };
    const full = roofParallax(building, camera, 1);
    const production = roofParallax(building, camera, 0.25);

    expect(production.x).toBeCloseTo(full.x * 0.25, 8);
    expect(production.y).toBeCloseTo(full.y * 0.25, 8);
  });

  it("has an exact off switch", () => {
    const building = downtownMap.buildings[0];
    expect(roofParallax(building, { x: 0, y: 0 }, 0)).toEqual({ x: 0, y: 0 });
  });
});
