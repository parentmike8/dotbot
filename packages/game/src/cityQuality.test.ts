import { describe, expect, it } from "vitest";

import { auditCity, MIN_FOOTWAY, type CityIssue } from "./cityQuality";
import { downtownMap } from "./content/downtown";
import type { Building, Doorway, MapDocument, Surface } from "./types";

/**
 * City-scale audit.
 *
 * Each case below is a defect that shipped in Downtown's first draft and had to
 * be found by eye — most of them by the person playing it rather than by anyone
 * reading the source. Turning "the map feels unfinished" into named, checkable
 * relationships is the whole point; the feeling is not reproducible and the
 * checks are.
 */

const bare = (overrides: Partial<MapDocument> = {}): MapDocument => ({
  id: "t",
  name: "T",
  visualTheme: "lit-model",
  width: 1200,
  height: 900,
  outdoor: { roads: [], parks: [], surfaces: [], walls: [], objects: [], dotSpawns: [] },
  buildings: [],
  extractionPoints: [],
  insertionPoints: [],
  botSpawns: [],
  ...overrides,
});

/** A single-floor box with an optional doorway on one face. */
const box = (id: string, x: number, y: number, w: number, h: number, doorways: Doorway[] = []): Building => ({
  id,
  kind: "warehouse",
  name: id.toUpperCase(),
  footprint: { x, y, w, h },
  floors: [{ id: `${id}:GROUND`, label: "GROUND", walls: [], doorways, objects: [], stairs: [], dotSpawns: [] }],
});

const paving = (id: string, kind: Surface["kind"], x: number, y: number, w: number, h: number): Surface =>
  ({ id, kind, x, y, w, h });

const kinds = (issues: CityIssue[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return counts;
};
const only = (issues: CityIssue[], kind: CityIssue["kind"]): CityIssue[] =>
  issues.filter((issue) => issue.kind === kind);

describe("entrances and the street", () => {
  /** A road across the top, its south footway, and a building set behind it. */
  const street = () => ({
    roads: [{ id: "main", x: 0, y: 200, w: 1200, h: 120 }],
    footway: paving("main-footway-s", "footway", 0, 320, 1200, 96),
  });

  it("passes a door that opens onto a forecourt joined to the footway", () => {
    const { roads, footway } = street();
    const map = bare({
      outdoor: {
        roads,
        parks: [],
        surfaces: [footway, paving("court", "forecourt", 380, 416, 200, 84)],
        walls: [], objects: [], dotSpawns: [],
      },
      buildings: [box("shop", 300, 500, 400, 300, [{ id: "front", x: 480, y: 500, width: 90, dir: "h" }])],
    });
    expect(only(auditCity(map), "entrance-without-approach")).toEqual([]);
  });

  it("flags a door that opens onto ground with no use at all", () => {
    const { roads, footway } = street();
    const map = bare({
      outdoor: { roads, parks: [], surfaces: [footway], walls: [], objects: [], dotSpawns: [] },
      buildings: [box("shop", 300, 500, 400, 300, [{ id: "front", x: 480, y: 500, width: 90, dir: "h" }])],
    });
    expect(only(auditCity(map), "entrance-without-approach")[0].message)
      .toMatch(/opens onto unassigned ground/);
  });

  /**
   * Beacon House's east door, exactly: paving that joined the door to the
   * courtyard and to nothing else. Walkable, named, and still not a way out.
   */
  it("flags a door onto paving that never reaches a carriageway", () => {
    const { roads, footway } = street();
    const map = bare({
      outdoor: {
        roads,
        parks: [],
        surfaces: [
          footway,
          paving("court", "forecourt", 380, 500, 200, 84),
          // A verge between the forecourt and the footway: walkable, but not a route.
          paving("planting", "verge", 0, 416, 1200, 84),
        ],
        walls: [], objects: [], dotSpawns: [],
      },
      buildings: [box("shop", 300, 584, 400, 300, [{ id: "front", x: 480, y: 584, width: 90, dir: "h" }])],
    });
    expect(only(auditCity(map), "entrance-without-approach")[0].message)
      .toMatch(/never reaches a carriageway/);
  });
});

describe("streets, frontage and setback", () => {
  it("flags a building fronting a street with no footway between them", () => {
    const map = bare({
      outdoor: {
        roads: [{ id: "main", x: 0, y: 200, w: 1200, h: 120 }],
        parks: [], surfaces: [], walls: [], objects: [], dotSpawns: [],
      },
      buildings: [box("shop", 300, 340, 400, 200)],
    });
    expect(only(auditCity(map), "street-without-footway")[0].message)
      .toMatch(/shop fronting its south side/);
  });

  it("says nothing about the side of a street nobody has built on", () => {
    const map = bare({
      outdoor: {
        roads: [{ id: "main", x: 0, y: 200, w: 1200, h: 120 }],
        parks: [],
        surfaces: [paving("main-footway-s", "footway", 0, 320, 1200, MIN_FOOTWAY)],
        walls: [], objects: [], dotSpawns: [],
      },
      buildings: [box("shop", 300, 420, 400, 200)],
    });
    expect(only(auditCity(map), "street-without-footway")).toEqual([]);
  });

  it("flags a building that stands too far off every road", () => {
    const map = bare({
      outdoor: {
        roads: [{ id: "r", x: 0, y: 0, w: 1200, h: 100 }],
        parks: [], surfaces: [], walls: [], objects: [], dotSpawns: [],
      },
      buildings: [box("adrift", 500, 600, 100, 100)],
    });
    expect(only(auditCity(map), "building-adrift")).toHaveLength(1);
  });

  it("flags a road with nothing built along it", () => {
    const map = bare({
      outdoor: {
        roads: [{ id: "lonely", x: 0, y: 0, w: 1200, h: 100 }],
        parks: [], surfaces: [], walls: [], objects: [], dotSpawns: [],
      },
    });
    expect(only(auditCity(map), "road-without-frontage")).toHaveLength(1);
  });
});

describe("ground nobody decided anything about", () => {
  it("reports one entry per hole, with its size and extent", () => {
    const issues = only(auditCity(bare()), "unassigned-ground");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/107\dk units² of ground from 0,0 to 1200,89\d has no use/);
  });

  it("says nothing when every part of the sheet has a use", () => {
    const map = bare({
      outdoor: {
        roads: [], parks: [],
        surfaces: [paving("all", "plaza", 0, 0, 1200, 900)],
        walls: [], objects: [], dotSpawns: [],
      },
    });
    expect(only(auditCity(map), "unassigned-ground")).toEqual([]);
  });

  it("ignores a leftover corner too small to stand around in", () => {
    const map = bare({
      outdoor: {
        roads: [], parks: [],
        surfaces: [paving("most", "plaza", 0, 0, 1200, 800), paving("rest", "yard", 0, 800, 1100, 100)],
        walls: [], objects: [], dotSpawns: [],
      },
    });
    expect(only(auditCity(map), "unassigned-ground")).toEqual([]);
  });
});

/**
 * Downtown, after the street-first replan.
 *
 * Asserted empty with `toEqual` rather than by count, so a regression names
 * itself in the failure output instead of showing up as a number that moved.
 */
describe("Downtown's city-scale debt", () => {
  it("has none left", () => {
    expect(auditCity(downtownMap).map((issue) => issue.message)).toEqual([]);
    expect(kinds(auditCity(downtownMap))).toEqual({});
  });
});
