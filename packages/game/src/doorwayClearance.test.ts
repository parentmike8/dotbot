import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { worldMap } from "./content/world";
import {
  DOORWAY_STEERING_MARGIN,
  doorwayHalfClearance,
  doorwayNormal,
  doorwayTangent,
  minimumNavigableDoorwayWidth,
  openingCutGeometry,
} from "./doorwayClearance";
import { findNavigationPath } from "./navigation";
import type { Doorway, MapDocument, Vec2, WallSegment } from "./types";

function undersizedDoorways(map: MapDocument): string[] {
  const requiredHalfWidth = defaultGameConfig.botRadius + DOORWAY_STEERING_MARGIN;
  const issues: string[] = [];

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      for (const doorway of floor.doorways) {
        const barrierId = doorway.id.replace(/-d\d+$/, "");
        const barrier = floor.barriers?.find((candidate) => candidate.id === barrierId);
        if (!barrier) {
          issues.push(`${floor.id} ${doorway.id}: no source barrier found`);
          continue;
        }
        const halfClearance = doorwayHalfClearance(doorway, barrier.solids);
        if (halfClearance + 1e-6 < requiredHalfWidth) {
          issues.push(
            `${floor.id} ${doorway.id}: ${halfClearance.toFixed(2)} from centre to collision;`
            + ` needs ${requiredHalfWidth}`,
          );
        }
      }
    }
  }

  return issues.sort();
}

function untraversableDoorways(map: MapDocument): string[] {
  const issues: string[] = [];
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      for (const doorway of floor.doorways) {
        const { map: testMap, doorway: testDoorway } = isolatedDoorwayMap(map, doorway);
        const normal = doorwayNormal(testDoorway);
        const from = {
          x: testDoorway.x - normal.x * 160,
          y: testDoorway.y - normal.y * 160,
        };
        const to = {
          x: testDoorway.x + normal.x * 160,
          y: testDoorway.y + normal.y * 160,
        };
        const path = findNavigationPath(testMap, "door-test:F1", from, to, defaultGameConfig.botRadius);
        if (!pathCrossesDoorway(path, testDoorway)) {
          issues.push(
            `${floor.id} ${doorway.id}: no full-size path from`
            + ` (${from.x.toFixed(1)},${from.y.toFixed(1)}) to (${to.x.toFixed(1)},${to.y.toFixed(1)})`,
          );
        }
      }
    }
  }
  return issues.sort();
}

/**
 * Preserve each production doorway's world-coordinate grid phase, width,
 * orientation and wall thickness, while removing room furniture and alternate
 * routes. The small block on the approach defeats the pathfinder's direct-line
 * fast path, so this exercises the actual graph that failed 56-wide doors.
 */
function isolatedDoorwayMap(
  map: MapDocument,
  sourceDoorway: Doorway,
): { map: MapDocument; doorway: Doorway } {
  const phase = (value: number): number => ((value - defaultGameConfig.botRadius) % 8 + 8) % 8;
  const shift = {
    x: 256 + phase(sourceDoorway.x) - sourceDoorway.x,
    y: 256 + phase(sourceDoorway.y) - sourceDoorway.y,
  };
  const doorway: Doorway = {
    ...sourceDoorway,
    x: sourceDoorway.x + shift.x,
    y: sourceDoorway.y + shift.y,
    ...(sourceDoorway.span ? {
      span: {
        ax: sourceDoorway.span.ax + shift.x,
        ay: sourceDoorway.span.ay + shift.y,
        bx: sourceDoorway.span.bx + shift.x,
        by: sourceDoorway.span.by + shift.y,
      },
    } : {}),
  };
  const tangent = doorwayTangent(doorway);
  const normal = doorwayNormal(doorway);
  const radius = (doorway.thickness ?? 8) / 2;
  const spineHalfGap = doorway.width / 2 + radius;
  const leftEnd = {
    x: doorway.x - tangent.x * spineHalfGap,
    y: doorway.y - tangent.y * spineHalfGap,
  };
  const rightStart = {
    x: doorway.x + tangent.x * spineHalfGap,
    y: doorway.y + tangent.y * spineHalfGap,
  };
  const blockerCenter = {
    x: doorway.x - normal.x * 90,
    y: doorway.y - normal.y * 90,
  };
  const blocker: WallSegment = {
    id: "direct-path-blocker",
    x: blockerCenter.x - 4,
    y: blockerCenter.y - 4,
    w: 8,
    h: 8,
  };
  const templateBuilding = map.buildings[0];
  const templateFloor = templateBuilding.floors[0];

  const testMap: MapDocument = {
    ...map,
    width: 512,
    height: 512,
    outdoor: {
      ...map.outdoor,
      walls: [],
      barriers: [],
      objects: [],
      dotSpawns: [],
    },
    buildings: [{
      ...templateBuilding,
      id: "door-test",
      footprint: { x: 0, y: 0, w: 512, h: 512 },
      outline: [
        { x: 0, y: 0 },
        { x: 512, y: 0 },
        { x: 512, y: 512 },
        { x: 0, y: 512 },
      ],
      floors: [{
        ...templateFloor,
        id: "door-test:F1",
        label: "F1",
        bounds: { x: 0, y: 0, w: 512, h: 512 },
        walls: [blocker],
        barriers: [{
          id: "test-wall",
          solids: [
            {
              kind: "capsule",
              ax: leftEnd.x - tangent.x * 2_000,
              ay: leftEnd.y - tangent.y * 2_000,
              bx: leftEnd.x,
              by: leftEnd.y,
              r: radius,
            },
            {
              kind: "capsule",
              ax: rightStart.x,
              ay: rightStart.y,
              bx: rightStart.x + tangent.x * 2_000,
              by: rightStart.y + tangent.y * 2_000,
              r: radius,
            },
          ],
        }],
        doorways: [doorway],
        objects: [],
        stairs: [],
        dotSpawns: [],
      }],
    }],
    botSpawns: [],
    insertionPoints: [],
    extractionPoints: [],
    interactionDots: [],
  };
  return { map: testMap, doorway };
}

function pathCrossesDoorway(path: Vec2[], doorway: Doorway): boolean {
  if (path.length < 2) return false;
  const normal = doorwayNormal(doorway);
  const tangent = doorwayTangent(doorway);
  const centerLaneHalfWidth = doorway.width / 2 - defaultGameConfig.botRadius;

  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const aSide = (a.x - doorway.x) * normal.x + (a.y - doorway.y) * normal.y;
    const bSide = (b.x - doorway.x) * normal.x + (b.y - doorway.y) * normal.y;
    if (aSide * bSide > 0 || Math.abs(aSide - bSide) < 1e-7) continue;
    const alpha = aSide / (aSide - bSide);
    const crossing = {
      x: a.x + (b.x - a.x) * alpha,
      y: a.y + (b.y - a.y) * alpha,
    };
    const along =
      (crossing.x - doorway.x) * tangent.x
      + (crossing.y - doorway.y) * tangent.y;
    if (Math.abs(along) <= centerLaneHalfWidth + 1e-6) return true;
  }
  return false;
}

describe.each([
  ["the world", worldMap],
  ["downtown", downtownMap],
] as const)("%s doorway clearance", (_name, map) => {
  it("gives every opening a bot radius plus steering margin on both sides", () => {
    expect(undersizedDoorways(map)).toEqual([]);
  });

  it("lets the production navigator cross every doorway", { timeout: 60_000 }, () => {
    expect(untraversableDoorways(map)).toEqual([]);
  });
});

describe("doorway cut geometry", () => {
  it.each([8, 12, 20])(
    "pulls capsule spines back far enough for the same clear opening in a %s-thick wall",
    (wallThickness) => {
      const cut = openingCutGeometry(56, wallThickness);
      expect(cut.clearWidth).toBe(minimumNavigableDoorwayWidth());
      expect(cut.spineGapWidth).toBe(cut.clearWidth + wallThickness);
      expect(cut.jambInset).toBe(wallThickness / 2);
    },
  );
});

describe("Mercy F1 regression route", () => {
  it("plans from the recovery ward through the standard person door into the stair core", () => {
    const path = findNavigationPath(
      downtownMap,
      "mercy:F1",
      { x: 570, y: 300 },
      { x: 700, y: 440 },
      defaultGameConfig.botRadius,
    );
    expect(path.length).toBeGreaterThan(0);
  });
});
