import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "../config";
import { collectSolidRects } from "../collision";
import { objectCollisionRects, physicsFloorId, stairGuardRects, stairHalves } from "../mapModel";
import { findNavigationPath } from "../navigation";
import { DotBotSimulation } from "../simulation";
import type { FloorPlan, Rect, Vec2 } from "../types";
import { CORNER_SHOP_FLOORS, cornerShopMap, cornerShopReviewPoints } from "./cornerShop";

const FLOOR_ID = "corner-shop:GROUND";
const radius = defaultGameConfig.botRadius;

function center(rect: Rect): Vec2 {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function distanceFromSolids(floorId: string, point: Vec2): number {
  return Math.min(...collectSolidRects(cornerShopMap, floorId).map((rect) => {
    const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
    const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
    return Math.hypot(point.x - nearestX, point.y - nearestY);
  }));
}

function arrivalPoint(floor: FloorPlan): Vec2 {
  if (floor.label === "GROUND") return cornerShopReviewPoints.entry;
  const down = floor.stairs.find((stair) => stair.direction === "down");
  if (!down) throw new Error(`No arrival stair on ${floor.id}`);
  return center(stairHalves(down).entry);
}

describe("corner shop detail-test map", () => {
  it("keeps every intended room zone reachable by a full-size DotBot", () => {
    for (const [name, point] of Object.entries(cornerShopReviewPoints)) {
      const path = findNavigationPath(cornerShopMap, FLOOR_ID, cornerShopReviewPoints.entry, point, radius);
      expect(path.length, `${name} is unreachable`).toBeGreaterThan(0);
      expect(path[0]).toEqual(cornerShopReviewPoints.entry);
      expect(path.at(-1)).toEqual(point);
    }
  });

  it("keeps the subtle interaction dot stand-on-able", () => {
    const dot = cornerShopMap.interactionDots?.[0];
    expect(dot).toBeDefined();
    const blocked = collectSolidRects(cornerShopMap, FLOOR_ID).some((rect) => {
      const nearestX = Math.max(rect.x, Math.min(dot!.position.x, rect.x + rect.w));
      const nearestY = Math.max(rect.y, Math.min(dot!.position.y, rect.y + rect.h));
      return Math.hypot(dot!.position.x - nearestX, dot!.position.y - nearestY) < radius;
    });
    expect(blocked).toBe(false);
  });

  it("preserves a comfortable storefront opening", () => {
    const entry = cornerShopMap.buildings[0].floors[0].doorways.find((door) => door.id === "shop-entry");
    expect(entry?.width).toBeGreaterThanOrEqual(radius * 4);
  });

  it("builds a five-level vertical route with paired mid-stride stairs", () => {
    const floors = cornerShopMap.buildings[0].floors;
    expect(floors.map((floor) => floor.id)).toEqual(Object.values(CORNER_SHOP_FLOORS));

    for (const floor of floors) {
      for (const stair of floor.stairs) {
        expect(stair.access, `${stair.id} must declare its access geometry`).toBe("openEnd");
        expect(stairGuardRects(stair), `${stair.id} must have two rails and one far-end cap`).toHaveLength(3);
        expect(stair.rect.w).toBeGreaterThanOrEqual(radius * 4);
        expect(stair.rect.h).toBeGreaterThanOrEqual(radius * 7);

        const targetPhysics = physicsFloorId(cornerShopMap, stair.toFloorId);
        const target = floors.find((candidate) => physicsFloorId(cornerShopMap, candidate.id) === targetPhysics);
        expect(target, `${stair.id} target floor is missing`).toBeDefined();
        const reverse = target!.stairs.find((candidate) =>
          physicsFloorId(cornerShopMap, candidate.toFloorId) === physicsFloorId(cornerShopMap, floor.id) &&
          candidate.direction !== stair.direction &&
          candidate.bottom === stair.bottom &&
          JSON.stringify(candidate.rect) === JSON.stringify(stair.rect));
        expect(reverse, `${stair.id} has no coordinate-identical reverse stair`).toBeDefined();
      }
    }
  });

  it("keeps both stair flights together in one west-side vertical zone", () => {
    const stairs = Object.values(cornerShopMap.buildings[0].floors.flatMap((floor) => floor.stairs));
    expect(new Set(stairs.map((stair) => stair.rect.x))).toEqual(new Set([150]));
  });

  it("keeps F1's east service wall ordered around one full-size circulation lane", () => {
    const floor = cornerShopMap.buildings[0].floors.find((candidate) => candidate.id === CORNER_SHOP_FLOORS.f1)!;
    const solids = floor.objects
      .map((object) => ({ id: object.id, rects: objectCollisionRects(object) }))
      .filter((object) => object.rects.length > 0);

    for (let leftIndex = 0; leftIndex < solids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < solids.length; rightIndex += 1) {
        for (const left of solids[leftIndex].rects) {
          for (const right of solids[rightIndex].rects) {
            const overlaps = left.x < right.x + right.w && left.x + left.w > right.x &&
              left.y < right.y + right.h && left.y + left.h > right.y;
            expect(overlaps, `${solids[leftIndex].id} overlaps ${solids[rightIndex].id}`).toBe(false);
          }
        }
      }
    }

    for (const point of [
      { x: 800, y: 220 },
      { x: 800, y: 320 },
      { x: 800, y: 440 },
      { x: 800, y: 520 },
      { x: 800, y: 620 },
    ]) {
      expect(distanceFromSolids(floor.id, point), `east aisle pinched at ${point.x},${point.y}`).toBeGreaterThanOrEqual(radius);
    }
  });

  it("keeps every stair, loot Dot, and AI spawn reachable from the arrival stair", () => {
    const floors = cornerShopMap.buildings[0].floors;

    for (const floor of floors) {
      const start = arrivalPoint(floor);
      const destinations = [
        ...floor.stairs.map((stair) => ({ name: stair.id, point: center(stairHalves(stair).entry) })),
        ...floor.dotSpawns.map((dot) => ({ name: dot.id, point: dot.position })),
        ...cornerShopMap.botSpawns
          .filter((spawn) => physicsFloorId(cornerShopMap, spawn.floorId ?? "outdoor") === physicsFloorId(cornerShopMap, floor.id))
          .map((spawn) => ({ name: spawn.id, point: spawn.position })),
      ];

      for (const destination of destinations) {
        const path = findNavigationPath(cornerShopMap, floor.id, start, destination.point, radius);
        expect(path.length, `${destination.name} is unreachable on ${floor.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every loot Dot and AI center a full DotBot radius away from solids", () => {
    const floors = cornerShopMap.buildings[0].floors;
    for (const floor of floors) {
      for (const dot of floor.dotSpawns) {
        expect(distanceFromSolids(floor.id, dot.position), `${dot.id} is too close to a solid`).toBeGreaterThanOrEqual(radius);
      }
      for (const spawn of cornerShopMap.botSpawns.filter((candidate) =>
        physicsFloorId(cornerShopMap, candidate.floorId ?? "outdoor") === physicsFloorId(cornerShopMap, floor.id))) {
        expect(distanceFromSolids(floor.id, spawn.position), `${spawn.id} is too close to a solid`).toBeGreaterThanOrEqual(radius);
      }
    }
  });

  it("keeps the exploration encounter intentionally escalated by floor", () => {
    const counts = Object.values(CORNER_SHOP_FLOORS).map((floorId) =>
      cornerShopMap.botSpawns.filter((spawn) =>
        spawn.id !== "player" && physicsFloorId(cornerShopMap, spawn.floorId ?? "outdoor") === physicsFloorId(cornerShopMap, floorId)).length);
    expect(counts).toEqual([0, 0, 1, 1, 2]);
    expect(new Set(cornerShopMap.botSpawns.filter((spawn) => spawn.id !== "player").map((spawn) => spawn.squadId))).toEqual(
      new Set(["mercer-defenders"]),
    );
  });

  it("crosses every authored stair mid-stride in the production simulation", async () => {
    const player = cornerShopMap.botSpawns.find((spawn) => spawn.id === "player")!;

    for (const floor of cornerShopMap.buildings[0].floors) {
      for (const stair of floor.stairs) {
        const halves = stairHalves(stair);
        const start = center(halves.entry);
        const finish = center(halves.exit);
        const length = Math.hypot(finish.x - start.x, finish.y - start.y);
        const move = { x: (finish.x - start.x) / length, y: (finish.y - start.y) / length };
        const simulation = await DotBotSimulation.create({
          map: {
            ...cornerShopMap,
            botSpawns: [{ ...player, position: start, floorId: floor.id }],
          },
        });

        simulation.applyInput("player", { move, dash: false });
        for (let tick = 0; tick < 45; tick += 1) simulation.step();
        const result = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;

        expect(result.floorId, `${stair.id} did not cross floors`).toBe(physicsFloorId(cornerShopMap, stair.toFloorId));
        if (halves.vertical) {
          expect(result.position.x, `${stair.id} shifted sideways`).toBeCloseTo(start.x, 2);
        } else {
          expect(result.position.y, `${stair.id} shifted sideways`).toBeCloseTo(start.y, 2);
        }
        simulation.dispose();
      }
    }
  });

  it("blocks side entry into the non-enterable half without changing floors", async () => {
    const player = cornerShopMap.botSpawns.find((spawn) => spawn.id === "player")!;

    for (const floor of cornerShopMap.buildings[0].floors) {
      for (const stair of floor.stairs) {
        const { exit } = stairHalves(stair);
        const start = {
          x: stair.rect.x + stair.rect.w + radius + 4,
          y: exit.y + exit.h / 2,
        };
        const simulation = await DotBotSimulation.create({
          map: {
            ...cornerShopMap,
            botSpawns: [{ ...player, position: start, floorId: floor.id }],
          },
        });

        simulation.applyInput("player", { move: { x: -1, y: 0 }, dash: false });
        for (let tick = 0; tick < 45; tick += 1) simulation.step();
        const result = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;

        expect(result.floorId, `${stair.id} changed floors through its side`).toBe(physicsFloorId(cornerShopMap, floor.id));
        expect(result.position.x, `${stair.id} allowed side entry`).toBeGreaterThanOrEqual(stair.rect.x + stair.rect.w + radius - 0.01);
        simulation.dispose();
      }
    }
  });

  it("lets a full-size DotBot leave the active stair half through its open side", async () => {
    const player = cornerShopMap.botSpawns.find((spawn) => spawn.id === "player")!;

    for (const floor of cornerShopMap.buildings[0].floors) {
      for (const stair of floor.stairs) {
        const { entry } = stairHalves(stair);
        const simulation = await DotBotSimulation.create({
          map: {
            ...cornerShopMap,
            botSpawns: [{ ...player, position: center(entry), floorId: floor.id }],
          },
        });

        simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
        for (let tick = 0; tick < 45; tick += 1) simulation.step();
        const result = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;

        expect(result.floorId, `${stair.id} changed floors while leaving sideways`).toBe(physicsFloorId(cornerShopMap, floor.id));
        expect(result.position.x, `${stair.id} trapped the bot inside its active half`).toBeGreaterThanOrEqual(
          stair.rect.x + stair.rect.w + radius - 0.01,
        );
        simulation.dispose();
      }
    }
  });
});
