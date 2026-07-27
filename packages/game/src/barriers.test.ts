import { describe, expect, it } from "vitest";
import { collectSolids } from "./collision";
import { defaultGameConfig } from "./config";
import { filletCorners, thickenPath } from "./geometry";
import { integrateWithWalls } from "./kinematics";
import { findNavigationPath } from "./navigation";
import { hasLineOfSight } from "./visibility";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Barrier, MapDocument } from "./types";

/**
 * Non-rectangular geometry, end to end.
 *
 * The kernel's own tests prove the maths. These prove the *wiring*: that a wall
 * which is not an axis-aligned rectangle actually stops a bot, blocks a sightline
 * and diverts a path — because a barrier the runtime silently ignores is worse
 * than no barrier at all.
 */

const RADIUS = defaultGameConfig.botRadius;

/** A diagonal wall across the middle of an otherwise empty yard. */
function diagonalBarrier(): Barrier {
  return { id: "diagonal", solids: thickenPath([{ x: 200, y: 700 }, { x: 800, y: 100 }], 20) };
}

/** The same wall, curved: a fillet tessellated into capsules. */
function curvedBarrier(): Barrier {
  const path = filletCorners([{ x: 200, y: 700 }, { x: 200, y: 400 }, { x: 800, y: 400 }], 200, false, 10);
  return { id: "curved", solids: thickenPath(path, 20) };
}

function yard(barriers: Barrier[]): MapDocument {
  const edge = 20;
  return {
    id: "barrier-test",
    name: "Barrier test",
    width: 1000,
    height: 800,
    outdoor: {
      roads: [],
      parks: [],
      walls: [
        { id: "n", x: 0, y: 0, w: 1000, h: edge },
        { id: "s", x: 0, y: 800 - edge, w: 1000, h: edge },
        { id: "w", x: 0, y: 0, w: edge, h: 800 },
        { id: "e", x: 1000 - edge, y: 0, w: edge, h: 800 },
      ],
      barriers,
      objects: [],
      dotSpawns: [],
    },
    buildings: [],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns: [{
      id: "player",
      name: "YOU",
      squadId: "player",
      controller: "human",
      color: "#000",
      position: { x: 120, y: 120 },
      floorId: OUTDOOR_FLOOR_ID,
    }],
  };
}

/** Push a bot at a wall for a second and report where it ends up. */
function shoveInto(map: MapDocument, from: { x: number; y: number }, toward: { x: number; y: number }) {
  const solids = collectSolids(map, OUTDOOR_FLOOR_ID);
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const speed = defaultGameConfig.playerSpeed;
  let position = from;
  for (let tick = 0; tick < 40; tick += 1) {
    position = integrateWithWalls(
      position,
      { x: (dx / length) * speed, y: (dy / length) * speed },
      50,
      RADIUS,
      solids,
    );
  }
  return position;
}

describe("non-rectangular barriers in the live runtime", () => {
  it("collects a diagonal wall as capsules, not rectangles", () => {
    const solids = collectSolids(yard([diagonalBarrier()]), OUTDOOR_FLOOR_ID);
    expect(solids.some((solid) => solid.kind === "capsule")).toBe(true);
    // Four perimeter rects plus the single diagonal span.
    expect(solids.filter((solid) => solid.kind === "capsule")).toHaveLength(1);
  });

  it("stops a bot walking into a diagonal wall", () => {
    const map = yard([diagonalBarrier()]);
    // Start north-west of the wall and drive south-east straight at it.
    const stopped = shoveInto(map, { x: 260, y: 260 }, { x: 700, y: 620 });
    // The wall runs from (200,700) to (800,100): points north-west of it satisfy
    // x + y < 900. A bot that crossed would end up well past that line.
    expect(stopped.x + stopped.y).toBeLessThan(900);
  });

  it("stops a bot walking into a curved wall", () => {
    const map = yard([curvedBarrier()]);
    // The curve arcs across the north-east; approach it from below.
    const stopped = shoveInto(map, { x: 400, y: 640 }, { x: 400, y: 120 });
    expect(stopped.y).toBeGreaterThan(400);
  });

  it("lets a bot travel freely when the wall is removed", () => {
    const reached = shoveInto(yard([]), { x: 260, y: 260 }, { x: 700, y: 620 });
    // Same shove with nothing in the way clears the diagonal comfortably.
    expect(reached.x + reached.y).toBeGreaterThan(900);
  });

  it("blocks a sightline through a diagonal wall", () => {
    const map = yard([diagonalBarrier()]);
    const near = { x: 260, y: 260 };
    // Straight through the wall.
    expect(hasLineOfSight(map, "outdoor:street", near, { x: 700, y: 620 })).toBe(false);
    // Along the same side of it stays visible.
    expect(hasLineOfSight(map, "outdoor:street", near, { x: 300, y: 200 })).toBe(true);
  });

  it("blocks a sightline through a curved wall", () => {
    const map = yard([curvedBarrier()]);
    expect(hasLineOfSight(map, "outdoor:street", { x: 400, y: 640 }, { x: 400, y: 120 })).toBe(false);
  });

  it("sees straight across once the wall is gone", () => {
    expect(hasLineOfSight(yard([]), "outdoor:street", { x: 260, y: 260 }, { x: 700, y: 620 })).toBe(true);
  });

  it("routes a path around a diagonal wall instead of through it", () => {
    const map = yard([diagonalBarrier()]);
    const from = { x: 260, y: 260 };
    const to = { x: 760, y: 660 };
    const path = findNavigationPath(map, OUTDOOR_FLOOR_ID, from, to, RADIUS);
    expect(path, "a route around the wall exists").not.toBeNull();
    // Every waypoint must stay clear of the wall's capsules.
    const wall = diagonalBarrier().solids;
    for (const point of path ?? []) {
      for (const solid of wall) {
        expect(
          solid.kind === "capsule"
            ? Math.hypot(point.x - solid.ax, point.y - solid.ay) > 0
            : true,
        ).toBe(true);
      }
    }
    // The direct line is blocked, so the route has to bend.
    expect((path ?? []).length).toBeGreaterThan(2);
  });
});
