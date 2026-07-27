import { describe, expect, it } from "vitest";
import { findNavigationPath, prewarmNavigation } from "./navigation";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Building, FloorPlan, MapDocument, MapObject, Rect, Vec2, WallSegment } from "./types";

const WIDTH = 240;
const HEIGHT = 160;
const START = { x: 30, y: 80 };
const GOAL = { x: 210, y: 80 };
const BARRIER: WallSegment = { id: "barrier", x: 110, y: 35, w: 20, h: 90 };

function makeMap(overrides: Partial<MapDocument> = {}): MapDocument {
  return {
    id: "navigation-test",
    name: "Navigation Test",
    width: WIDTH,
    height: HEIGHT,
    outdoor: {
      roads: [],
      parks: [],
      walls: [],
      objects: [],
      dotSpawns: [],
    },
    buildings: [],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns: [],
    ...overrides,
  };
}

function floor(id: string, label: FloorPlan["label"], walls: WallSegment[] = [], objects: MapObject[] = []): FloorPlan {
  return {
    id,
    label,
    walls,
    doorways: [],
    objects,
    stairs: [],
    dotSpawns: [],
  };
}

function building(floors: FloorPlan[]): Building {
  return {
    id: "tower",
    kind: "office",
    name: "TOWER",
    footprint: { x: 0, y: 0, w: WIDTH, h: HEIGHT },
    floors,
  };
}

function solidObject(id: string, rect: Rect): MapObject {
  return { id, kind: "desk", ...rect };
}

function withOutdoor(map: MapDocument, walls: WallSegment[] = [], objects: MapObject[] = []): MapDocument {
  return {
    ...map,
    outdoor: {
      ...map.outdoor,
      walls,
      objects,
    },
  };
}

describe("findNavigationPath", () => {
  it("uses the direct-path fast path and includes both endpoints", () => {
    const path = findNavigationPath(makeMap(), OUTDOOR_FLOOR_ID, START, GOAL, 10);

    expect(path).toEqual([START, GOAL]);
  });

  it("routes deterministically around an obstacle and smooths the grid path", () => {
    const map = withOutdoor(makeMap(), [BARRIER]);
    const first = findNavigationPath(map, OUTDOOR_FLOOR_ID, START, GOAL, 10);
    const second = findNavigationPath(map, OUTDOOR_FLOOR_ID, START, GOAL, 10);

    expect(first).toEqual(second);
    expect(first[0]).toEqual(START);
    expect(first.at(-1)).toEqual(GOAL);
    expect(first.length).toBeGreaterThan(2);
    expect(first.length).toBeLessThan(8);
  });

  it("invalidates a warmed cache when collision geometry mutates in place", () => {
    const map = makeMap();

    expect(findNavigationPath(map, OUTDOOR_FLOOR_ID, START, GOAL, 10)).toEqual([START, GOAL]);
    map.outdoor.walls.push(BARRIER);

    const updated = findNavigationPath(map, OUTDOOR_FLOOR_ID, START, GOAL, 10);
    expect(updated[0]).toEqual(START);
    expect(updated.at(-1)).toEqual(GOAL);
    expect(updated.length).toBeGreaterThan(2);
  });

  it("prewarms every distinct physics floor and preserves floor-specific paths", () => {
    const map = makeMap({
      buildings: [
        building([
          floor("tower:GROUND", "GROUND", [BARRIER]),
          floor("tower:F1", "F1"),
          floor("tower:F2", "F2", [], [solidObject("upper-desk", BARRIER)]),
        ]),
      ],
    });

    prewarmNavigation(map, 10);

    expect(findNavigationPath(map, OUTDOOR_FLOOR_ID, START, GOAL, 10).length).toBeGreaterThan(2);
    expect(findNavigationPath(map, "tower:GROUND", START, GOAL, 10).length).toBeGreaterThan(2);
    expect(findNavigationPath(map, "tower:F1", START, GOAL, 10)).toEqual([START, GOAL]);
    expect(findNavigationPath(map, "tower:F2", START, GOAL, 10).length).toBeGreaterThan(2);
  });

  it("rebuilds prewarmed graphs after in-place geometry changes", () => {
    const upper = floor("tower:F1", "F1");
    const map = makeMap({ buildings: [building([floor("tower:GROUND", "GROUND"), upper])] });

    prewarmNavigation(map, 10);
    expect(findNavigationPath(map, "tower:F1", START, GOAL, 10)).toEqual([START, GOAL]);

    upper.walls.push(BARRIER);
    prewarmNavigation(map, 10);
    expect(findNavigationPath(map, "tower:F1", START, GOAL, 10).length).toBeGreaterThan(2);
  });

  it("safely ignores malformed maps and unusable radii", () => {
    const malformed = { width: WIDTH, height: HEIGHT } as MapDocument;
    const map = makeMap();

    expect(() => prewarmNavigation(malformed, 10)).not.toThrow();
    expect(() => prewarmNavigation(map, Number.NaN)).not.toThrow();
    expect(() => prewarmNavigation(map, -1)).not.toThrow();
    expect(() => prewarmNavigation(map, WIDTH)).not.toThrow();
  });

  it("mirrors every source of collision on the shared outdoor physics floor", () => {
    const groundWall = floor("tower:GROUND", "GROUND", [BARRIER]);
    const groundObject = floor("tower:GROUND", "GROUND", [], [solidObject("ground-desk", BARRIER)]);
    const cases: MapDocument[] = [
      withOutdoor(makeMap(), [BARRIER]),
      withOutdoor(makeMap(), [], [solidObject("outdoor-desk", BARRIER)]),
      makeMap({ buildings: [building([groundWall])] }),
      makeMap({ buildings: [building([groundObject])] }),
    ];

    for (const map of cases) {
      const path = findNavigationPath(map, OUTDOOR_FLOOR_ID, START, GOAL, 10);
      expect(path.length).toBeGreaterThan(2);
    }
  });

  it("ignores outdoor and GROUND collision upstairs but uses that floor's walls and solid objects", () => {
    const clearUpper = makeMap({
      outdoor: withOutdoor(makeMap(), [BARRIER]).outdoor,
      buildings: [building([floor("tower:GROUND", "GROUND", [BARRIER]), floor("tower:F1", "F1")])],
    });
    const upperWall = makeMap({
      buildings: [building([floor("tower:GROUND", "GROUND"), floor("tower:F1", "F1", [BARRIER])])],
    });
    const upperObject = makeMap({
      buildings: [
        building([
          floor("tower:GROUND", "GROUND"),
          floor("tower:F1", "F1", [], [solidObject("upper-desk", BARRIER)]),
        ]),
      ],
    });

    expect(findNavigationPath(clearUpper, "tower:F1", START, GOAL, 10)).toEqual([START, GOAL]);
    expect(findNavigationPath(upperWall, "tower:F1", START, GOAL, 10).length).toBeGreaterThan(2);
    expect(findNavigationPath(upperObject, "tower:F1", START, GOAL, 10).length).toBeGreaterThan(2);
  });

  it("normalizes a GROUND plan id to the shared outdoor collision floor", () => {
    const map = makeMap({ buildings: [building([floor("tower:GROUND", "GROUND", [BARRIER])])] });

    expect(findNavigationPath(map, "tower:GROUND", START, GOAL, 10).length).toBeGreaterThan(2);
  });

  it("honors radius clearance and returns no path through a gap narrower than the bot", () => {
    const gapWalls: WallSegment[] = [
      { id: "gap-top", x: 116, y: 0, w: 8, h: 65 },
      { id: "gap-bottom", x: 116, y: 95, w: 8, h: 65 },
    ];
    const map = withOutdoor(makeMap(), gapWalls);
    const smallStart: Vec2 = { x: 40, y: 80 };
    const smallGoal: Vec2 = { x: 200, y: 80 };

    expect(findNavigationPath(map, OUTDOOR_FLOOR_ID, smallStart, smallGoal, 10)).toEqual([smallStart, smallGoal]);
    expect(findNavigationPath(map, OUTDOOR_FLOOR_ID, smallStart, smallGoal, 16)).toEqual([]);
  });

  it("rejects unknown floors and obstructed endpoints", () => {
    const map = withOutdoor(makeMap(), [BARRIER]);

    expect(findNavigationPath(map, "missing:F9", START, GOAL, 10)).toEqual([]);
    expect(findNavigationPath(map, OUTDOOR_FLOOR_ID, { x: 115, y: 80 }, GOAL, 10)).toEqual([]);
  });
});
