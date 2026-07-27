import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { doorwayOnPerimeter, doorwayStyle } from "./doorwayStyle";

/**
 * Derived from the shipped map rather than from named doorway ids, so the rule is
 * checked against every entrance and every interior door the game actually has —
 * and a renamed opening cannot quietly retire a case.
 */
describe("doorway drawing", () => {
  const openings = downtownMap.buildings.flatMap((building) =>
    building.floors.flatMap((floor) =>
      floor.doorways.map((doorway) => ({ building, doorway })),
    ),
  );

  it("leaves every exterior entrance completely open", () => {
    const perimeter = openings.filter(({ building, doorway }) =>
      doorwayOnPerimeter(doorway, building.footprint));
    expect(perimeter.length).toBeGreaterThan(4);
    for (const { building, doorway } of perimeter) {
      expect(doorwayStyle(doorway, building.footprint), doorway.id).toBe("open");
    }
  });

  it("uses a sliding-door language for interior rooms", () => {
    const interior = openings.filter(({ building, doorway }) =>
      !doorwayOnPerimeter(doorway, building.footprint) && !doorway.open);
    expect(interior.length).toBeGreaterThan(4);
    for (const { building, doorway } of interior) {
      expect(doorwayStyle(doorway, building.footprint), doorway.id).toBe("sliding");
    }
  });

  it("preserves explicitly open interior archways", () => {
    const archway = { id: "open-arch", x: 300, y: 300, width: 72, dir: "h" as const, open: true };
    const footprint = downtownMap.buildings[0].footprint;
    expect(doorwayStyle(archway, footprint)).toBe("open");
  });
});
