import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { BASE_SHELL_IDS, createBaseMap, starterBaseLayout } from "./content/base";
import type { BaseLayout } from "./types";
import { collisionLayers, isGroundFloor, isSolidObject, physicsFloorId, stairExitPoint, stairHalves } from "./mapModel";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Doorway, MapDocument, Rect, StairLink, Vec2 } from "./types";

/**
 * Map validation (spec: "Dot spawn zones do not overlap walls", "Objects do
 * not block critical paths"): flood-fill each physics floor on a coarse grid
 * and assert every dot spawn and bot spawn is reachable from a seed point.
 */

const CELL = 8;
const BOT_RADIUS = defaultGameConfig.botRadius;
/** A bot must get its center within this range of a dot to capture it. */
const CAPTURE_RANGE = BOT_RADIUS - defaultGameConfig.dotRadius - 2;

type FloorWorld = {
  floorId: string;
  solids: Rect[];
  seeds: Vec2[];
  dots: Array<{ id: string; position: Vec2 }>;
  spawns: Array<{ id: string; position: Vec2 }>;
  stairs: StairLink[];
  doorways: Doorway[];
};

function collectFloors(map: MapDocument = downtownMap): FloorWorld[] {
  const floors = new Map<string, FloorWorld>();
  const floor = (floorId: string): FloorWorld => {
    let world = floors.get(floorId);

    if (!world) {
      world = { floorId, solids: [], seeds: [], dots: [], spawns: [], stairs: [], doorways: [] };
      floors.set(floorId, world);
    }

    return world;
  };

  const outdoor = floor(OUTDOOR_FLOOR_ID);
  outdoor.solids.push(...map.outdoor.walls, ...map.outdoor.objects.filter(isSolidObject));
  outdoor.dots.push(...map.outdoor.dotSpawns.map((spawn) => ({ id: spawn.id, position: spawn.position })));

  for (const building of map.buildings) {
    for (const plan of building.floors) {
      const world = floor(physicsFloorId(map, plan.id));
      world.solids.push(...plan.walls, ...plan.objects.filter(isSolidObject));
      world.dots.push(...plan.dotSpawns.map((spawn) => ({ id: spawn.id, position: spawn.position })));
      world.stairs.push(...plan.stairs);
      world.doorways.push(...plan.doorways);

      // Stair arrival points seed non-ground floors; GROUND flows from outdoors.
      if (!isGroundFloor(plan)) {
        for (const other of building.floors) {
          for (const stair of other.stairs) {
            if (stair.toFloorId === plan.id) {
              world.seeds.push(stairExitPoint(stair));
            }
          }
        }
      }
    }
  }

  for (const spawn of map.botSpawns) {
    const world = floor(physicsFloorId(map, spawn.floorId ?? OUTDOOR_FLOOR_ID));
    world.spawns.push({ id: spawn.id, position: spawn.position });

    if (spawn.controller === "human") {
      world.seeds.push(spawn.position);
    }
  }

  return [...floors.values()];
}

function circleClearsRects(center: Vec2, radius: number, rects: Rect[]): boolean {
  for (const rect of rects) {
    const dx = center.x - Math.max(rect.x, Math.min(center.x, rect.x + rect.w));
    const dy = center.y - Math.max(rect.y, Math.min(center.y, rect.y + rect.h));

    if (dx * dx + dy * dy < radius * radius) {
      return false;
    }
  }

  return true;
}

function floodReachable(world: FloorWorld, map: MapDocument = downtownMap): Set<number> {
  const cols = Math.ceil(map.width / CELL);
  const rows = Math.ceil(map.height / CELL);
  const cellCenter = (index: number): Vec2 => ({
    x: (index % cols) * CELL + CELL / 2,
    y: Math.floor(index / cols) * CELL + CELL / 2,
  });
  const open = (index: number): boolean => {
    const center = cellCenter(index);

    if (
      center.x < BOT_RADIUS ||
      center.y < BOT_RADIUS ||
      center.x > map.width - BOT_RADIUS ||
      center.y > map.height - BOT_RADIUS
    ) {
      return false;
    }

    return circleClearsRects(center, BOT_RADIUS - 1, world.solids);
  };

  const reachable = new Set<number>();
  const queue: number[] = [];

  for (const seed of world.seeds) {
    const index = Math.floor(seed.y / CELL) * cols + Math.floor(seed.x / CELL);

    if (open(index)) {
      reachable.add(index);
      queue.push(index);
    }
  }

  while (queue.length > 0) {
    const index = queue.pop()!;
    const col = index % cols;

    for (const next of [index - cols, index + cols, col > 0 ? index - 1 : -1, col < cols - 1 ? index + 1 : -1]) {
      if (next >= 0 && next < cols * rows && !reachable.has(next) && open(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  return reachable;
}

function nearestReachableDistance(target: Vec2, reachable: Set<number>, range: number, map: MapDocument = downtownMap): number {
  const cols = Math.ceil(map.width / CELL);
  let best = Number.POSITIVE_INFINITY;
  const span = Math.ceil((range + CELL) / CELL);
  const baseCol = Math.floor(target.x / CELL);
  const baseRow = Math.floor(target.y / CELL);

  for (let row = baseRow - span; row <= baseRow + span; row += 1) {
    for (let col = baseCol - span; col <= baseCol + span; col += 1) {
      if (!reachable.has(row * cols + col)) {
        continue;
      }

      const cx = col * CELL + CELL / 2;
      const cy = row * CELL + CELL / 2;
      best = Math.min(best, Math.hypot(cx - target.x, cy - target.y));
    }
  }

  return best;
}

describe("downtown map validation", () => {
  const worlds = collectFloors();

  it("ships four distinct buildings with an eight-floor tower", () => {
    expect(downtownMap.buildings).toHaveLength(4);
    expect(new Set(downtownMap.buildings.map((building) => building.kind))).toEqual(
      new Set(["hospital", "office", "warehouse", "residential"]),
    );

    const civic = downtownMap.buildings.find((building) => building.id === "civic");
    expect(civic?.floors.filter((floor) => floor.label !== "ROOF")).toHaveLength(8);
    expect(civic?.floors.at(-1)?.label).toBe("ROOF");
    expect(new Set(collisionLayers(downtownMap).values()).size).toBeLessThanOrEqual(16);
  });

  it("fails explicitly before a map exceeds Rapier's 16 collision layers", () => {
    const overflowMap: MapDocument = {
      ...downtownMap,
      buildings: [
        {
          id: "overflow",
          kind: "office",
          name: "OVERFLOW",
          footprint: { x: 40, y: 40, w: 200, h: 200 },
          floors: Array.from({ length: 16 }, (_, index) => ({
            id: `overflow:F${index + 1}`,
            label: "F1" as const,
            walls: [],
            doorways: [],
            objects: [],
            stairs: [],
            dotSpawns: [],
          })),
        },
      ],
    };

    expect(() => collisionLayers(overflowMap)).toThrow(/at most 16 physics collision layers/);
  });

  it("has a seed for every physics floor", () => {
    for (const world of worlds) {
      expect(world.seeds.length, `floor ${world.floorId} needs a seed`).toBeGreaterThan(0);
    }
  });

  it("keeps every dot spawn capturable from reachable ground", () => {
    for (const world of worlds) {
      const reachable = floodReachable(world);

      for (const dot of world.dots) {
        const distance = nearestReachableDistance(dot.position, reachable, CAPTURE_RANGE);
        expect(
          distance,
          `dot ${dot.id} at (${dot.position.x}, ${dot.position.y}) on ${world.floorId} is not capturable`,
        ).toBeLessThanOrEqual(CAPTURE_RANGE);
      }
    }
  });

  it("generates one registered blueprint per scannable object type per building", () => {
    for (const building of downtownMap.buildings) {
      const expected = new Set(building.floors.flatMap((floor) => floor.objects.filter((object) => object.scannable).map((object) => object.kind)));
      const blueprints = building.floors.flatMap((floor) => floor.dotSpawns)
        .filter((spawn) => spawn.item.kind === "blueprint");
      expect(new Set(blueprints.map((spawn) => spawn.item.kind === "blueprint" ? spawn.item.blueprintId : ""))).toEqual(expected);
      expect(blueprints).toHaveLength(expected.size);
    }
  });

  it("keeps every bot spawn on reachable ground", () => {
    for (const world of worlds) {
      const reachable = floodReachable(world);

      for (const spawn of world.spawns) {
        const distance = nearestReachableDistance(spawn.position, reachable, BOT_RADIUS);
        expect(
          distance,
          `bot ${spawn.id} at (${spawn.position.x}, ${spawn.position.y}) on ${world.floorId} spawns in a sealed spot`,
        ).toBeLessThanOrEqual(BOT_RADIUS);
      }
    }
  });

  it("keeps every stair entrance reachable on its floor", () => {
    for (const world of worlds) {
      const reachable = floodReachable(world);

      for (const stair of world.stairs) {
        const { entry } = stairHalves(stair);
        const point = { x: entry.x + entry.w / 2, y: entry.y + entry.h / 2 };
        const distance = nearestReachableDistance(point, reachable, BOT_RADIUS);
        expect(
          distance,
          `stair ${stair.id} entry on ${world.floorId} cannot be reached`,
        ).toBeLessThanOrEqual(BOT_RADIUS);
      }
    }
  });

  it("keeps every doorway usable from both sides", () => {
    // A door is usable when a bot can stand just off the wall on either side.
    const clearance = 38;

    for (const world of worlds) {
      const reachable = floodReachable(world);

      for (const doorway of world.doorways) {
        for (const side of [-1, 1]) {
          const point =
            doorway.dir === "h"
              ? { x: doorway.x, y: doorway.y + side * clearance }
              : { x: doorway.x + side * clearance, y: doorway.y };
          const distance = nearestReachableDistance(point, reachable, BOT_RADIUS);
          expect(
            distance,
            `doorway ${doorway.id} at (${doorway.x}, ${doorway.y}) on ${world.floorId} is blocked on one side`,
          ).toBeLessThanOrEqual(BOT_RADIUS);
        }
      }
    }
  });
});

/** Richest solid furnishing: every shared slot is occupied with M6 kinds. */
const maximalBaseLayout: BaseLayout = {
  "wall-nw": "fabricator",
  "wall-n": "locker",
  "wall-ne": "locker",
  "wall-east": "bayConsole",
  "wall-west": "repairBench",
  "wall-se": "shelf",
  "floor-nw": "bed",
  "floor-center": "planningTable",
  "floor-ne": "serverRack",
  "floor-south": "workbench",
};

describe.each(BASE_SHELL_IDS.map((shellId) => [shellId] as const))("base map validation (%s shell)", (shellId) => {
  const map = createBaseMap(maximalBaseLayout, shellId);
  const [world] = collectFloors(map);

  it("is deterministic and contains only the player with empty bays", () => {
    expect(createBaseMap(starterBaseLayout, shellId)).toEqual(createBaseMap({ ...starterBaseLayout }, shellId));
    expect(map.outdoor.dotSpawns).toEqual([]);
    expect(map.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.dotSpawns))).toEqual([]);
    expect(map.botSpawns).toEqual([
      expect.objectContaining({ id: "player", controller: "human", bays: [null, null, null, null], hold: [] }),
    ]);
  });

  it("exposes the identical slot roster as every other shell", () => {
    const roster = map.placementSlots!.map((slot) => ({ id: slot.id, zone: slot.zone }));
    for (const otherId of BASE_SHELL_IDS) {
      const other = createBaseMap(starterBaseLayout, otherId);
      expect(other.placementSlots!.map((slot) => ({ id: slot.id, zone: slot.zone }))).toEqual(roster);
    }
  });

  it("keeps the spawn, every slot, and the deployment threshold reachable when fully furnished", () => {
    const reachable = floodReachable(world, map);
    const spawn = map.botSpawns[0];
    expect(nearestReachableDistance(spawn.position, reachable, BOT_RADIUS, map)).toBeLessThanOrEqual(BOT_RADIUS);

    for (const slot of map.placementSlots!) {
      const center = { x: slot.rect.x + slot.rect.w / 2, y: slot.rect.y + slot.rect.h / 2 };
      const interactionReach = Math.hypot(slot.rect.w, slot.rect.h) / 2 + 48;
      expect(
        nearestReachableDistance(center, reachable, interactionReach, map),
        `base slot ${slot.id} cannot be approached`,
      ).toBeLessThanOrEqual(interactionReach);
    }

    const threshold = map.extractionPoints[0].rect;
    const center = { x: threshold.x + threshold.w / 2, y: threshold.y + threshold.h / 2 };
    expect(nearestReachableDistance(center, reachable, BOT_RADIUS, map)).toBeLessThanOrEqual(BOT_RADIUS);
  });

  it("rejects unknown slots, object kinds, and zone mismatches", () => {
    expect(() => createBaseMap({ mystery: "locker" }, shellId)).toThrow(/Unknown base placement slot/);
    expect(() => createBaseMap({ "wall-n": "not-real" } as never, shellId)).toThrow(/Unknown base object kind/);
    expect(() => createBaseMap({ "floor-center": "fabricator" }, shellId)).toThrow(/cannot be placed in floor slot/);
    expect(() => createBaseMap({ "wall-west": "repairBench", "wall-se": "repairBench" }, shellId)).toThrow(/duplicate repairBench/);
  });
});
