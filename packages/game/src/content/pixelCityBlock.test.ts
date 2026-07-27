import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "../config";
import { objectCollisionRects, stairGuardRects, stairHalves } from "../mapModel";
import { auditBuildingFloorQuality } from "../mapQuality";
import { findNavigationPath } from "../navigation";
import { DotBotSimulation } from "../simulation";
import { OUTDOOR_FLOOR_ID } from "../types";
import type { FloorPlan, Rect, Vec2 } from "../types";
import { PIXEL_CITY_FLOORS, pixelCityBlockMap } from "./pixelCityBlock";

const radius = defaultGameConfig.botRadius;

function floorSolids(floor: FloorPlan): Rect[] {
  return [
    ...floor.walls,
    ...floor.objects.flatMap((object) => objectCollisionRects(object)),
    ...floor.stairs.flatMap((stair) => stairGuardRects(stair)),
  ];
}

function clearsSolids(point: Vec2, solids: Rect[], clearance: number): boolean {
  return solids.every((rect) => {
    const nx = Math.max(rect.x, Math.min(point.x, rect.x + rect.w));
    const ny = Math.max(rect.y, Math.min(point.y, rect.y + rect.h));
    return Math.hypot(point.x - nx, point.y - ny) >= clearance;
  });
}

/** A reliable on-floor start: the center of a stair entry half. */
function floorStart(floor: FloorPlan): Vec2 {
  const stair = floor.stairs[0];
  const { entry } = stairHalves(stair);
  return { x: entry.x + entry.w / 2, y: entry.y + entry.h / 2 };
}

describe("pixel city block production slice", () => {
  it("passes the generic floor quality audit for every building", () => {
    for (const building of pixelCityBlockMap.buildings) {
      expect(
        auditBuildingFloorQuality(pixelCityBlockMap, building.id),
        `${building.id} fails the floor quality audit`,
      ).toEqual([]);
    }
  });

  it("pairs every stair with a coordinate-identical reverse flight", () => {
    for (const building of pixelCityBlockMap.buildings) {
      for (const floor of building.floors) {
        for (const stair of floor.stairs) {
          const target = building.floors.find((candidate) => candidate.id === stair.toFloorId);
          expect(target, `${stair.id} targets missing floor ${stair.toFloorId}`).toBeDefined();
          const reverse = target!.stairs.find((candidate) => candidate.toFloorId === floor.id
            && candidate.rect.x === stair.rect.x && candidate.rect.y === stair.rect.y);
          expect(reverse, `${stair.id} has no coordinate-identical reverse pair`).toBeDefined();
          expect(reverse!.rect).toEqual(stair.rect);
          expect(reverse!.direction).not.toBe(stair.direction);
          expect(reverse!.bottom).toBe(stair.bottom);
          expect(stair.access).toBe("openEnd");
        }
      }
    }
  });

  it("keeps every Dot and AI spawn reachable and radius-safe on its floor", () => {
    for (const building of pixelCityBlockMap.buildings) {
      for (const floor of building.floors) {
        const solids = floorSolids(floor);
        const start = floorStart(floor);
        for (const spawn of floor.dotSpawns) {
          expect(
            clearsSolids(spawn.position, solids, radius),
            `${spawn.id} is closer than a bot radius to solid geometry`,
          ).toBe(true);
          const path = findNavigationPath(pixelCityBlockMap, floor.id, start, spawn.position, radius);
          expect(path.length, `${spawn.id} is unreachable from the stair entry`).toBeGreaterThan(0);
        }
        for (const bot of pixelCityBlockMap.botSpawns.filter((candidate) => candidate.floorId === floor.id)) {
          expect(
            clearsSolids(bot.position, solids, radius),
            `${bot.id} spawns too close to solid geometry`,
          ).toBe(true);
          const path = findNavigationPath(pixelCityBlockMap, floor.id, start, bot.position, radius);
          expect(path.length, `${bot.id} spawn is unreachable`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("authors the Bakery and Coolies entrances as animated automatic doors", () => {
    const bakery = pixelCityBlockMap.buildings.find((building) => building.id === "blue-shop")!;
    const coolies = pixelCityBlockMap.buildings.find((building) => building.id === "red-shop")!;
    expect(bakery.floors[0].doorways).toEqual([
      expect.objectContaining({ id: "bakery-entry", assetKey: "bakery-door", x: 1128, mechanism: "automatic" }),
    ]);
    expect(coolies.floors[0].doorways).toEqual([
      expect.objectContaining({ id: "coolies-entry", assetKey: "clothes-door", x: 1464, mechanism: "automatic" }),
    ]);
    for (const [building, door] of [[bakery, bakery.floors[0].doorways[0]], [coolies, coolies.floors[0].doorways[0]]] as const) {
      const south = building.floors[0].walls
        .filter((candidate) => candidate.y === 440)
        .sort((a, b) => a.x - b.x);
      expect(south[0].x + south[0].w).toBe(door.x - door.width / 2);
      expect(south[1].x).toBe(door.x + door.width / 2);
    }
  });

  it("reaches every small-shop Dot from its front door", () => {
    for (const [floorId, doorInside] of [
      [PIXEL_CITY_FLOORS.blue, { x: 1128, y: 400 }],
      [PIXEL_CITY_FLOORS.red, { x: 1464, y: 400 }],
    ] as const) {
      const floor = pixelCityBlockMap.buildings
        .flatMap((building) => building.floors)
        .find((candidate) => candidate.id === floorId)!;
      for (const spawn of floor.dotSpawns) {
        const path = findNavigationPath(pixelCityBlockMap, floorId, doorInside, spawn.position, radius);
        expect(path.length, `${spawn.id} is unreachable from the door`).toBeGreaterThan(0);
      }
      const stairEntry = floorStart(floor);
      const path = findNavigationPath(pixelCityBlockMap, floorId, doorInside, stairEntry, radius);
      expect(path.length, `${floorId} stair is unreachable from the door`).toBeGreaterThan(0);
    }
  });

  it("escalates encounters with depth and keeps the learning floors peaceful", () => {
    const byFloor = (floorId: string) =>
      pixelCityBlockMap.botSpawns.filter((spawn) => spawn.floorId === floorId);
    expect(byFloor(PIXEL_CITY_FLOORS.shop)).toEqual([]);
    expect(byFloor(PIXEL_CITY_FLOORS.shopUpper)).toEqual([]);
    expect(byFloor(PIXEL_CITY_FLOORS.shopStorage)).toHaveLength(1);
    expect(byFloor(PIXEL_CITY_FLOORS.shopRepair)).toHaveLength(1);
    expect(byFloor(PIXEL_CITY_FLOORS.shopCore)).toHaveLength(2);
    const plumeSquads = new Set(
      pixelCityBlockMap.botSpawns
        .filter((spawn) => spawn.floorId?.startsWith("pixel-city:shop:"))
        .map((spawn) => spawn.squadId),
    );
    expect(plumeSquads.size).toBe(1);
    expect(byFloor(PIXEL_CITY_FLOORS.blueUpper)).toHaveLength(1);
    expect(byFloor(PIXEL_CITY_FLOORS.redUpper)).toHaveLength(1);
  });

  it("keeps every ground-floor Dot and exit reachable from the front entry", () => {
    const start = { x: 408, y: 640 };
    const floor = pixelCityBlockMap.buildings.find((building) => building.id === "pixel-parts")!.floors[0];
    const destinations = [
      ...floor.dotSpawns.map((dot) => ({ id: dot.id, position: dot.position })),
      { id: "back-exit", position: { x: 720, y: 168 } },
      { id: "east-front-exit", position: { x: 744, y: 640 } },
    ];
    for (const destination of destinations) {
      const path = findNavigationPath(pixelCityBlockMap, PIXEL_CITY_FLOORS.shop, start, destination.position, radius);
      expect(path.length, `${destination.id} is unreachable`).toBeGreaterThan(0);
    }
  });

  it("keeps the upper floor peaceful and its blueprint reachable from the stair landing", () => {
    const floor = pixelCityBlockMap.buildings
      .find((building) => building.id === "pixel-parts")!
      .floors.find((candidate) => candidate.id === PIXEL_CITY_FLOORS.shopUpper)!;
    expect(pixelCityBlockMap.botSpawns.filter((spawn) =>
      spawn.floorId === PIXEL_CITY_FLOORS.shop || spawn.floorId === PIXEL_CITY_FLOORS.shopUpper,
    )).toEqual([]);

    for (const dot of floor.dotSpawns) {
      const path = findNavigationPath(
        pixelCityBlockMap,
        PIXEL_CITY_FLOORS.shopUpper,
        { x: 264, y: 330 },
        dot.position,
        radius,
      );
      expect(path.length, `${dot.id} is unreachable`).toBeGreaterThan(0);
    }
  });

  it("pairs the Pixel City stair at identical coordinates and traverses both ways mid-stride", async () => {
    const shop = pixelCityBlockMap.buildings.find((building) => building.id === "pixel-parts")!;
    const groundStair = shop.floors.find((floor) => floor.id === PIXEL_CITY_FLOORS.shop)!.stairs[0];
    const upperStair = shop.floors.find((floor) => floor.id === PIXEL_CITY_FLOORS.shopUpper)!.stairs[0];
    expect(groundStair).toMatchObject({
      direction: "up",
      toFloorId: PIXEL_CITY_FLOORS.shopUpper,
      bottom: "S",
      access: "openEnd",
      rect: upperStair.rect,
    });
    expect(upperStair).toMatchObject({
      direction: "down",
      toFloorId: PIXEL_CITY_FLOORS.shop,
      bottom: "S",
      access: "openEnd",
    });

    const map = {
      ...pixelCityBlockMap,
      botSpawns: [{
        id: "player",
        name: "Player",
        squadId: "alpha",
        controller: "human" as const,
        color: "#22c7d8",
        position: { x: 264, y: 438 },
        floorId: PIXEL_CITY_FLOORS.shop,
      }],
    };
    const simulation = await DotBotSimulation.create({ map });
    const samples: Array<{ floorId: string; position: { x: number; y: number } }> = [];
    const move = (y: number, count: number) => {
      for (let index = 0; index < count; index += 1) {
        simulation.applyInput("player", { move: { x: 0, y }, dash: false });
        simulation.step();
        const bot = simulation.getSnapshot().bots.find((candidate) => candidate.id === "player")!;
        samples.push({ floorId: bot.floorId, position: { ...bot.position } });
      }
    };

    move(-1, 60);
    expect(samples.at(-1)!.floorId).toBe(PIXEL_CITY_FLOORS.shopUpper);
    const upwardChange = samples.findIndex((sample, index) => index > 0 && sample.floorId !== samples[index - 1].floorId);
    expect(upwardChange).toBeGreaterThan(0);
    expect(Math.hypot(
      samples[upwardChange].position.x - samples[upwardChange - 1].position.x,
      samples[upwardChange].position.y - samples[upwardChange - 1].position.y,
    )).toBeLessThan(8);

    move(1, 60);
    expect(samples.at(-1)!.floorId).toBe(OUTDOOR_FLOOR_ID);
    simulation.dispose();
  });

  it("traverses the full Plume Parts climb and descent mid-stride", async () => {
    const map = {
      ...pixelCityBlockMap,
      botSpawns: [{
        id: "player",
        name: "Player",
        squadId: "alpha",
        controller: "human" as const,
        color: "#22c7d8",
        position: { x: 264, y: 438 },
        floorId: PIXEL_CITY_FLOORS.shop,
      }],
    };
    const simulation = await DotBotSimulation.create({ map });
    const bot = () => simulation.getSnapshot().bots.find((candidate) => candidate.id === "player")!;
    const steerTo = (target: Vec2, maxTicks = 400) => {
      for (let tick = 0; tick < maxTicks; tick += 1) {
        const position = bot().position;
        const dx = target.x - position.x;
        const dy = target.y - position.y;
        if (Math.hypot(dx, dy) <= 10) return;
        const length = Math.hypot(dx, dy) || 1;
        simulation.applyInput("player", { move: { x: dx / length, y: dy / length }, dash: false });
        simulation.step();
      }
      const position = bot().position;
      throw new Error(`stuck at ${Math.round(position.x)},${Math.round(position.y)} on ${bot().floorId} heading for ${target.x},${target.y}`);
    };
    const leg = (floorId: string, waypoints: Vec2[]) => {
      for (const waypoint of waypoints) steerTo(waypoint);
      expect(bot().floorId, `expected ${floorId} at ${JSON.stringify(bot().position)}`).toBe(floorId);
    };

    // Climb: alternate west and east flights of the single stair bank.
    leg(PIXEL_CITY_FLOORS.shopUpper, [{ x: 264, y: 300 }]);
    leg(PIXEL_CITY_FLOORS.shopStorage, [
      { x: 264, y: 250 }, { x: 450, y: 250 }, { x: 450, y: 430 },
      { x: 376, y: 430 }, { x: 376, y: 300 },
    ]);
    leg(PIXEL_CITY_FLOORS.shopRepair, [
      { x: 450, y: 300 }, { x: 450, y: 520 }, { x: 264, y: 520 },
      { x: 264, y: 430 }, { x: 264, y: 300 },
    ]);
    leg(PIXEL_CITY_FLOORS.shopCore, [
      { x: 300, y: 250 }, { x: 570, y: 250 }, { x: 570, y: 440 },
      { x: 376, y: 440 }, { x: 376, y: 300 },
    ]);

    // Descend the whole bank in reverse.
    leg(PIXEL_CITY_FLOORS.shopRepair, [{ x: 376, y: 460 }]);
    leg(PIXEL_CITY_FLOORS.shopStorage, [
      { x: 376, y: 500 }, { x: 188, y: 500 }, { x: 188, y: 330 },
      { x: 264, y: 330 }, { x: 264, y: 430 },
    ]);
    leg(PIXEL_CITY_FLOORS.shopUpper, [
      { x: 264, y: 520 }, { x: 450, y: 520 }, { x: 450, y: 300 },
      { x: 376, y: 300 }, { x: 376, y: 430 },
    ]);
    // GROUND shares the outdoor physics plane, so the floor id reads outdoor.
    leg(OUTDOOR_FLOOR_ID, [
      { x: 376, y: 520 }, { x: 188, y: 520 }, { x: 188, y: 330 },
      { x: 264, y: 330 }, { x: 264, y: 430 },
      { x: 400, y: 480 }, { x: 400, y: 600 }, { x: 408, y: 640 }, { x: 408, y: 780 },
    ]);
    simulation.dispose();
  });

  it("keeps the insertion, exterior encounter, entrance, and extraction connected", () => {
    const start = pixelCityBlockMap.insertionPoints[0].position;
    for (const destination of [
      { id: "front-entry", position: { x: 408, y: 720 } },
      { id: "park-dot", position: { x: 970, y: 810 } },
      { id: "extraction", position: { x: 1464, y: 898 } },
    ]) {
      const path = findNavigationPath(pixelCityBlockMap, OUTDOOR_FLOOR_ID, start, destination.position, radius);
      expect(path.length, `${destination.id} is unreachable`).toBeGreaterThan(0);
    }
  });

  it("keeps every shipped raster fixture paired with an explicit collider or passable flag", () => {
    const objects = [
      ...pixelCityBlockMap.outdoor.objects,
      ...pixelCityBlockMap.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.objects)),
    ];
    for (const object of objects.filter((candidate) => candidate.art)) {
      expect(object.solid, `${object.id} must declare its collision intent`).not.toBeUndefined();
      expect(Number.isInteger(object.art!.scale ?? 1), `${object.id} must remain at integer pixel scale`).toBe(true);
    }
  });

  it("aligns the playable interior surface to the exact exterior footprint", () => {
    const building = pixelCityBlockMap.buildings.find((candidate) => candidate.id === "pixel-parts")!;
    const floorPlacement = pixelCityBlockMap.artPlacements?.find((placement) => placement.id === "shop-floor");
    expect(floorPlacement).toMatchObject(building.footprint);
  });

  it("authors both public entrances as reusable animated automatic doors", () => {
    const floor = pixelCityBlockMap.buildings.find((building) => building.id === "pixel-parts")!.floors[0];
    const doors = floor.doorways.filter((door) => door.mechanism === "automatic");
    expect(doors).toEqual([
      expect.objectContaining({ id: "shop-front-entry", assetKey: "shop-door-blue", x: 408, width: 96 }),
      expect.objectContaining({ id: "shop-front-entry-east", assetKey: "shop-door-blue", x: 744, width: 96 }),
    ]);

    const southWalls = floor.walls
      .filter((wall) => wall.id.startsWith("shop-south"))
      .sort((a, b) => a.x - b.x);
    expect(southWalls[0].x + southWalls[0].w).toBe(doors[0].x - doors[0].width / 2);
    expect(southWalls[1].x).toBe(doors[0].x + doors[0].width / 2);
    expect(southWalls[1].x + southWalls[1].w).toBe(doors[1].x - doors[1].width / 2);
    expect(southWalls[2].x).toBe(doors[1].x + doors[1].width / 2);
  });

  it("keeps collision closed during the first frames, then opens, makes noise, and safely closes", async () => {
    const map = {
      ...pixelCityBlockMap,
      botSpawns: [{
        id: "player",
        name: "Player",
        squadId: "alpha",
        controller: "human" as const,
        color: "#22c7d8",
        position: { x: 408, y: 760 },
      }],
    };
    const simulation = await DotBotSimulation.create({ map });
    const step = (count: number, move = { x: 0, y: -1 }) => {
      simulation.applyInput("player", { move, dash: false });
      for (let index = 0; index < count; index += 1) simulation.step();
    };

    step(10);
    let snapshot = simulation.getSnapshot();
    const runtimeId = `${PIXEL_CITY_FLOORS.shop}:shop-front-entry`;
    expect(snapshot.doors?.find((door) => door.id === runtimeId)).toMatchObject({ phase: "opening", blocking: true });
    expect(snapshot.bots.find((bot) => bot.id === "player")!.position.y).toBeGreaterThanOrEqual(719);
    expect(snapshot.noises).toContainEqual(expect.objectContaining({ kind: "door", floorId: OUTDOOR_FLOOR_ID }));

    step(28);
    snapshot = simulation.getSnapshot();
    expect(snapshot.doors?.find((door) => door.id === runtimeId)).toMatchObject({ phase: "open", blocking: false });
    expect(snapshot.bots.find((bot) => bot.id === "player")!.position.y).toBeLessThan(680);

    step(40);
    step(110, { x: 0, y: 0 });
    snapshot = simulation.getSnapshot();
    expect(snapshot.doors?.find((door) => door.id === runtimeId)).toMatchObject({ phase: "closed", openness: 0, blocking: true });
    simulation.dispose();
  });
});
