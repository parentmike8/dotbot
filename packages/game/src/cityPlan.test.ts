import { describe, expect, it } from "vitest";

import { compileCityPlan, CityPlanError, MIN_FOOTWAY, type CityPlan } from "./cityPlan";

/**
 * The plan format's job is to make the bad map hard to author.
 *
 * Everything below is a defect that reached Downtown's first draft and had to be
 * found by eye. Each is now a compile error, which is a much better place for it
 * than an audit: an audit tells you the map is wrong, the format stops you
 * writing it down.
 */

const plan = (overrides: Partial<CityPlan> = {}): CityPlan => ({ streets: [], ...overrides });

describe("streets and the footways they produce", () => {
  it("centres the carriageway on the line and puts a footway either side", () => {
    const { roads, surfaces } = compileCityPlan(plan({
      streets: [{ id: "main", from: { x: 100, y: 500 }, to: { x: 900, y: 500 }, width: 120, footway: 96 }],
    }));

    expect(roads).toEqual([{ id: "main", x: 100, y: 440, w: 800, h: 120 }]);
    expect(surfaces).toEqual([
      { id: "main-footway-n", kind: "footway", x: 100, y: 344, w: 800, h: 96 },
      { id: "main-footway-s", kind: "footway", x: 100, y: 560, w: 800, h: 96 },
    ]);
  });

  it("flanks a north-south street east and west", () => {
    const { surfaces } = compileCityPlan(plan({
      streets: [{ id: "ave", from: { x: 500, y: 0 }, to: { x: 500, y: 400 }, width: 100, footway: 96 }],
    }));
    expect(surfaces.map((surface) => surface.id)).toEqual(["ave-footway-w", "ave-footway-e"]);
  });

  it("allows a service lane with no footway at all", () => {
    const { surfaces } = compileCityPlan(plan({
      streets: [{ id: "lane", from: { x: 0, y: 40 }, to: { x: 300, y: 40 }, width: 80 }],
    }));
    expect(surfaces).toEqual([]);
  });

  it("takes a footway on one side only", () => {
    const { surfaces } = compileCityPlan(plan({
      streets: [{ id: "quay", from: { x: 0, y: 200 }, to: { x: 400, y: 200 }, width: 100, footway: { n: 120 } }],
    }));
    expect(surfaces.map((surface) => surface.id)).toEqual(["quay-footway-n"]);
  });

  it("refuses a footway too narrow to walk down", () => {
    // The value that shipped: SIDEWALK = 20, against a 48-unit bot.
    expect(() => compileCityPlan(plan({
      streets: [{ id: "main", from: { x: 0, y: 100 }, to: { x: 400, y: 100 }, width: 100, footway: 20 }],
    }))).toThrow(new RegExp(`20-unit footway.*below ${MIN_FOOTWAY}`));
  });

  it("refuses a footway named on a side the street does not have", () => {
    expect(() => compileCityPlan(plan({
      streets: [{ id: "main", from: { x: 0, y: 100 }, to: { x: 400, y: 100 }, width: 100, footway: { e: 96 } }],
    }))).toThrow(/runs east-west, so it has no e side/);
  });

  it("refuses a diagonal street", () => {
    expect(() => compileCityPlan(plan({
      streets: [{ id: "skew", from: { x: 0, y: 0 }, to: { x: 400, y: 300 }, width: 100 }],
    }))).toThrow(CityPlanError);
  });
});

describe("approaches", () => {
  it("compiles a door-to-footway walk into forecourt paving", () => {
    const { surfaces } = compileCityPlan(plan({
      approaches: [{ id: "walk", from: { x: 300, y: 500 }, to: { x: 300, y: 620 }, width: 80 }],
    }));
    expect(surfaces).toEqual([{ id: "walk", kind: "forecourt", x: 260, y: 500, w: 80, h: 120 }]);
  });

  it("refuses an approach a bot cannot comfortably walk", () => {
    expect(() => compileCityPlan(plan({
      approaches: [{ id: "walk", from: { x: 0, y: 0 }, to: { x: 0, y: 100 }, width: 40 }],
    }))).toThrow(/it is a gap, not a path/);
  });
});

describe("the plan as a whole", () => {
  it("catches a reused id before it silently shadows something", () => {
    expect(() => compileCityPlan(plan({
      streets: [{ id: "main", from: { x: 0, y: 100 }, to: { x: 400, y: 100 }, width: 100 }],
      patches: [{ id: "main", kind: "yard", x: 0, y: 0, w: 50, h: 50 }],
    }))).toThrow(/duplicate id main/);
  });

  it("refuses a patch with no area", () => {
    expect(() => compileCityPlan(plan({
      patches: [{ id: "sliver", kind: "verge", x: 0, y: 0, w: 0, h: 200 }],
    }))).toThrow(/sliver is 0 x 200/);
  });
});
