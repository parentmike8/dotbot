import { describe, expect, it } from "vitest";
import { cornerShopMap } from "@dotbot/game/content/cornerShop";
import { doorwayStyle, perimeterDoorThresholdRect } from "./doorwayStyle";

describe("doorway drawing", () => {
  const building = cornerShopMap.buildings[0];
  const floor = building.floors[0];

  it("uses a sliding-door language for interior rooms", () => {
    const doorway = floor.doorways.find((candidate) => candidate.id === "stair-hall-door")!;
    expect(doorway).toBeDefined();
    expect(doorwayStyle(doorway, building.footprint)).toBe("sliding");
  });

  it("leaves exterior entrances completely open", () => {
    const doorway = floor.doorways.find((candidate) => candidate.id === "shop-entry")!;
    expect(doorwayStyle(doorway, building.footprint)).toBe("open");
  });

  it("keeps the interior side of a south facade door as a full-width open threshold", () => {
    const doorway = { id: "street-door", x: 408, y: 688, width: 96, dir: "h" as const, mechanism: "automatic" as const };
    expect(perimeterDoorThresholdRect(doorway, { x: 144, y: 120, w: 672, h: 576 })).toEqual({
      x: 360,
      y: 680,
      w: 96,
      h: 16,
    });
  });

  it("preserves explicitly open interior archways", () => {
    const doorway = { id: "open-arch", x: 300, y: 300, width: 72, dir: "h" as const, open: true };
    expect(doorwayStyle(doorway, building.footprint)).toBe("open");
  });
});
