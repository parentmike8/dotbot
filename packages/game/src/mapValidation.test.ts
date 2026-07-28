import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { BASE_GROUND_SLOT_DEFS, BASE_SHELL_IDS, BASE_SLOT_DEFS, BASE_UPPER_SLOT_DEFS, createBaseMap, deriveBaseInteractionDots, starterBaseLayout, validateBaseLayout } from "./content/base";
import { interactionDotReach } from "./interactions";
import type { BaseLayout } from "./types";
import { collisionLayers, isGroundFloor, objectCollisionRects, physicsFloorId, stairExitPoint, stairHalves } from "./mapModel";
import { auditDotPlacement, auditBuildingFloorQuality, type FloorQualityIssue } from "./mapQuality";
import { FLAT_KINDS, isSolidObject } from "./mapModel";
import { findNavigationPath } from "./navigation";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Doorway, MapDocument, MapObject, Rect, StairLink, Vec2 } from "./types";

/**
 * Map validation (spec: "Dot spawn zones do not overlap walls", "Objects do
 * not block critical paths"): flood-fill each physics floor on a coarse grid
 * and assert every dot spawn and bot spawn is reachable from a seed point.
 */

const CELL = 8;
const BOT_RADIUS = defaultGameConfig.botRadius;
/** A bot must get its center within this range of a dot to capture it. */
const CAPTURE_RANGE = interactionDotReach(BOT_RADIUS, defaultGameConfig.dotRadius);

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
  outdoor.solids.push(...map.outdoor.walls, ...map.outdoor.objects.flatMap(objectCollisionRects));
  outdoor.dots.push(...map.outdoor.dotSpawns.map((spawn) => ({ id: spawn.id, position: spawn.position })));

  for (const building of map.buildings) {
    for (const plan of building.floors) {
      const world = floor(physicsFloorId(map, plan.id));
      world.solids.push(...plan.walls, ...plan.objects.flatMap(objectCollisionRects));
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

  for (const dot of map.interactionDots ?? []) {
    floor(physicsFloorId(map, dot.floorId)).dots.push({ id: dot.id, position: dot.position });
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

  /**
   * The floor-quality audit is a production authoring gate, not a corner-shop
   * snapshot. Downtown shipped without this assertion, and an impassable
   * 6-unit gap between Lot 6's third rack run and the crates beside it survived
   * all the way to a screenshot review. Every building is gated now.
   */
  /**
   * Per-building, per-kind budgets that may only ever go down.
   *
   * Mercy, Civic and Beacon predate the audit being wired into downtown and
   * carry real authoring debt — recorded here so it is visible and cannot grow,
   * rather than hidden behind a suppressed assertion. Lot 6 is at zero and any
   * new building starts at zero.
   *
   * Budgets are counts per issue kind, not object ids: `objSeq` renumbers every
   * downstream object whenever one is added, so id-based baselines rot instantly.
   */
  const FLOOR_QUALITY_BUDGET: Record<string, Partial<Record<FloorQualityIssue["kind"], number>>> = {
    lot6: {},
    mercy: { "solid-overlap": 1 },
    civic: { "false-aisle": 7, "solid-overlap": 1 },
    // `disconnected-area: 1` is paid off: a shelf in the F1 lounge sealed the
    // roof stair. See beaconHouse.ts for why that room holds a couch and nothing
    // else. The `stair-unreachable` rule added alongside the fix is what should
    // have caught it — the stranded region was a stair shaft, whose standable area
    // is always too small to clear MIN_DISCONNECTED_AREA.
    beacon: { "false-aisle": 7 },
  };

  it("matches its recorded floor-quality debt exactly", () => {
    const actual = Object.fromEntries(downtownMap.buildings.map((building) => {
      const counts: Partial<Record<FloorQualityIssue["kind"], number>> = {};
      for (const issue of auditBuildingFloorQuality(downtownMap, building.id)) {
        counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
      }
      return [building.id, counts];
    }));
    // Exact, not a ceiling: paying debt down should require editing this ledger,
    // so the remaining total stays honest instead of drifting out of date.
    expect(actual).toEqual(FLOOR_QUALITY_BUDGET);
  });

  /**
   * Dots are the loot economy, so this one is asserted empty rather than budgeted.
   * A Dot nobody can reach and two Dots in the same place are both bugs, not debt.
   */
  it("places every Dot where a bot can reach it, and no two on top of each other", () => {
    expect(auditDotPlacement(downtownMap).map((issue) => issue.message)).toEqual([]);
  });

  it("keeps Lot 6 Depot completely clean, as the audited reference building", () => {
    expect(auditBuildingFloorQuality(downtownMap, "lot6").map((issue) => issue.message)).toEqual([]);
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

  it("holds the ghost ledger, which may only shrink", () => {
    /**
     * A ghost is an object drawn as a lifted volume throwing a shadow onto the slab
     * that a bot walks straight through. The contract's rule is silhouette ==
     * footprint == collider and `FLAT_KINDS` is its only sanctioned exception, so
     * every one of these is the map lying to the player about what is cover.
     *
     * A ratchet rather than a target. There were 114; eight kinds have been promoted
     * (toilet, sink, coffeeStation, washer, medicalCart, ivStand, utilityBox, plant —
     * 83 objects) and the one that remains is recorded here by name and count. New
     * ghosts cannot be authored: adding one fails this test. Promoting one fails it too,
     * which is the point — the number in this file is what you update when you have done
     * the repairs, and it is how the cost stays visible instead of being discovered
     * later by a player walking through a chair.
     *
     * The cost is never the set edit. A promoted kind is fatal at map-construction
     * time: `addBlueprintSpawns` throws the first time a scannable object has no
     * bot-clear side, so each promotion is an authoring pass that ends when the map
     * builds and the audits are quiet again. `utilityBox` cost two object moves,
     * `plant` four, and every one of the six was the same thing — a decoration standing
     * in a doorway, on a Dot, or in the only route through a room.
     *
     * `chair` is the last and the largest: 30 objects, seven scannable objects left
     * with no bot-clear side, two floors cut in half, and four chairs tucked under
     * tables that become `solid-overlap` the moment they collide. That one needs a
     * decision about tucked chairs before it needs an authoring pass.
     */
    const ghosts = new Map<string, number>();
    const record = (objects: readonly MapObject[]) => {
      for (const object of objects) {
        if (FLAT_KINDS.has(object.kind) || isSolidObject(object)) continue;
        ghosts.set(object.kind, (ghosts.get(object.kind) ?? 0) + 1);
      }
    };
    record(downtownMap.outdoor.objects);
    for (const building of downtownMap.buildings) {
      for (const floor of building.floors) record(floor.objects);
    }

    expect(Object.fromEntries([...ghosts].sort())).toEqual({
      // The last ghost on the map, and a deliberate one: a single authored
      // `solid: false` on the roof terrace planter, which is a low kerb of soil you
      // step over rather than a box you walk into.
      planter: 1,
    });
    const total = [...ghosts.values()].reduce((sum, count) => sum + count, 0);
    expect(total, "total ghosts; this number may only go down").toBe(1);
  });

  it("keeps the walking line through every doorway clear of solid objects", () => {
    /**
     * Reported from play, with a screenshot and the appropriate amount of laughter:
     * "and here the sign blocks the entry."
     *
     * It did, and the doorway check above passed it. That one probes a single POINT 38
     * units off the wall on each side and asks whether a bot can stand there — so an
     * object beside that point, squarely in the line you actually walk, never touches
     * it. The blind spot is the shape of the test: a door is not a point, it is a
     * corridor you pass through.
     *
     * So this sweeps the gap itself. The opening's clear width, extended a little way
     * either side of the wall, must contain no solid object footprint.
     *
     * A LITTLE way, and the first version got this wrong in a way worth recording. At a
     * bot's radius plus slack — a full 32-unit approach on both sides — it flagged nine
     * objects, six of them bathroom fixtures. An 88-by-68 WC with a 56-unit door cannot
     * give a bot's full approach depth on both sides of its own door; the corridor was
     * most of the room. Demanding it would mean bathrooms with nothing in them.
     *
     * So the rule is the threshold, not the approach: stand in the gap and you fail.
     * Getting from the gap to somewhere useful is what the flood-fill checks above are
     * for, and they are the right shape for it.
     */
    const APPROACH = 14;
    const blockers = new Set<string>();
    for (const world of worlds) {
      const solids = new Map<string, Rect[]>();
      const collect = (objects: readonly MapObject[]) => {
        for (const object of objects) {
          if (!isSolidObject(object)) continue;
          solids.set(object.id, objectCollisionRects(object));
        }
      };
      if (world.floorId === OUTDOOR_FLOOR_ID) collect(downtownMap.outdoor.objects);
      for (const building of downtownMap.buildings) {
        for (const floor of building.floors) {
          if (physicsFloorId(downtownMap, floor.id) === world.floorId) collect(floor.objects);
        }
      }

      for (const doorway of world.doorways) {
        // The corridor: as wide as the opening, as deep as a bot's approach on both
        // sides. `dir` is the wall's run, so the corridor crosses it.
        const half = doorway.width / 2;
        const corridor: Rect = doorway.dir === "h"
          ? { x: doorway.x - half, y: doorway.y - APPROACH, w: doorway.width, h: APPROACH * 2 }
          : { x: doorway.x - APPROACH, y: doorway.y - half, w: APPROACH * 2, h: doorway.width };
        for (const [id, rects] of solids) {
          for (const rect of rects) {
            const overlapX = Math.min(corridor.x + corridor.w, rect.x + rect.w) - Math.max(corridor.x, rect.x);
            const overlapY = Math.min(corridor.y + corridor.h, rect.y + rect.h) - Math.max(corridor.y, rect.y);
            if (overlapX > 0 && overlapY > 0) {
              blockers.add(`${id} @ ${doorway.id} (${doorway.x},${doorway.y}) ${world.floorId}`);
            }
          }
        }
      }
    }
    /**
     * Zero, and it stays zero. Not a ratchet — there is no debt left to record.
     *
     * Nine were found the first time this ran. Three of those were fixtures the same
     * session's bathroom repair had just moved into their own thresholds, which is
     * exactly what a new check earns its keep on. The other six were pre-existing
     * authoring: a basin or counter standing in a doorway, each clipping the threshold
     * by two to six units, none of it visible without measuring.
     *
     * Every repair was a nudge along the fixture's own wall. What made them tractable
     * was doing the arithmetic first — door centre, threshold reach, the fixture's span,
     * and what else is on that wall — rather than sliding things and re-running. Two of
     * the three would have gone into a wall if moved the obvious direction.
     */
    expect([...blockers].sort()).toEqual([]);
  });

  it("keeps every bot spawn somewhere the navigator can plan FROM", () => {
    /**
     * Reported from play: "this team AI bot still just sits here at the start of the
     * game and does nothing." It did — for the entire match, having never moved a
     * single pixel.
     *
     * `ally-2` was authored at (240, 890) with a 36x36 rock at (182, 862): a
     * clearance of exactly 22.00 against a bot radius of 24. `findNavigationPath`
     * tests the START point for clearance, so it returned an empty path to
     * *everywhere* — and `steerBotAlongPath` treats an empty path as "do not steer
     * through geometry" and returns zero. The bot then blacklisted every objective in
     * turn as unreachable, sixteen of them including the player, and stood still.
     * Three of thirteen spawns were like this: 22.00, 20.00 and 10.00 of clearance.
     *
     * The test above passed all three, and that is the lesson. It floods its own
     * coarse 8-unit grid and asks whether a spawn is NEAR reachable ground — a
     * second, more forgiving opinion about navigability than the one the game
     * actually runs on. Two sources of truth, and the softer one was the one being
     * checked. So this asks the shipped pathfinder, at the shipped radius, the
     * question the AI asks every tick: can you plan from here?
     *
     * Probed at short range on purpose. A goal 160 units out lands inside a wall on a
     * small indoor floor and fails for a reason that has nothing to do with the
     * spawn, which is how a first attempt at this "found" two more broken spawns that
     * were fine.
     */
    for (const world of worlds) {
      for (const spawn of world.spawns) {
        let planned = 0;
        for (let step = 0; step < 8; step += 1) {
          const angle = (step / 8) * Math.PI * 2;
          const goal = {
            x: spawn.position.x + Math.cos(angle) * 60,
            y: spawn.position.y + Math.sin(angle) * 60,
          };
          if (findNavigationPath(downtownMap, world.floorId, spawn.position, goal, BOT_RADIUS).length > 0) {
            planned += 1;
          }
        }
        expect(
          planned,
          `bot ${spawn.id} at (${spawn.position.x}, ${spawn.position.y}) on ${world.floorId}`
          + ` is wedged: the navigator cannot plan a path from where it stands, in any direction,`
          + ` so it will never move`,
        ).toBeGreaterThan(0);
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

const maximalExpandedBaseLayout: BaseLayout = {
  ...maximalBaseLayout,
  "up-wall-a": "locker",
  "up-wall-b": "shelf",
  "up-wall-c": "locker",
  "up-wall-d": "shelf",
  "up-floor-a": "bed",
  "up-floor-b": "couch",
};

describe("canonical base slot roster", () => {
  it("keeps ten legacy ground slots unchanged and adds exactly six canonical F1 slots", () => {
    expect(BASE_GROUND_SLOT_DEFS.map(({ id, zone }) => ({ id, zone }))).toEqual([
      { id: "wall-nw", zone: "wall" }, { id: "wall-n", zone: "wall" }, { id: "wall-ne", zone: "wall" },
      { id: "wall-east", zone: "wall" }, { id: "wall-west", zone: "wall" }, { id: "wall-se", zone: "wall" },
      { id: "floor-nw", zone: "floor" }, { id: "floor-center", zone: "floor" },
      { id: "floor-ne", zone: "floor" }, { id: "floor-south", zone: "floor" },
    ]);
    expect(BASE_UPPER_SLOT_DEFS.map(({ id, zone, floor }) => ({ id, zone, floor }))).toEqual([
      { id: "up-wall-a", zone: "wall", floor: "F1" }, { id: "up-wall-b", zone: "wall", floor: "F1" },
      { id: "up-wall-c", zone: "wall", floor: "F1" }, { id: "up-wall-d", zone: "wall", floor: "F1" },
      { id: "up-floor-a", zone: "floor", floor: "F1" }, { id: "up-floor-b", zone: "floor", floor: "F1" },
    ]);
    expect(BASE_SLOT_DEFS).toHaveLength(16);
  });

  it("rejects F1 layout rows until expansion ownership is supplied", () => {
    expect(() => validateBaseLayout({ "up-wall-a": "locker" })).toThrow(/requires expansion-secondFloor/);
    expect(() => createBaseMap({ ...starterBaseLayout, "up-wall-a": "locker" })).toThrow(/requires expansion-secondFloor/);
    expect(() => validateBaseLayout({ "up-wall-a": "locker" }, { expanded: true })).not.toThrow();
  });
});

describe.each(BASE_SHELL_IDS.map((shellId) => [shellId] as const))("base map validation (%s shell)", (shellId) => {
  const map = createBaseMap(maximalBaseLayout, shellId);
  const [world] = collectFloors(map);

  it("is deterministic and contains only the player with empty bays", () => {
    expect(createBaseMap(starterBaseLayout, shellId)).toEqual(createBaseMap({ ...starterBaseLayout }, shellId));
    expect(map.outdoor.dotSpawns).toEqual([]);
    expect(map.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.dotSpawns))).toEqual([]);
    expect(map.interactionDots).toHaveLength(map.buildings[0].floors.flatMap((floor) => floor.objects).length + 1);
    expect(map.botSpawns).toEqual([
      expect.objectContaining({ id: "player", controller: "human", bays: Array.from({ length: defaultGameConfig.baySlots }, () => null), hold: [] }),
    ]);
  });

  it("derives one dot for every placed object and deployment threshold, without exposing empty slots", () => {
    const starter = createBaseMap(starterBaseLayout, shellId);
    const objects = starter.buildings[0].floors.flatMap((floor) => floor.objects);
    const dots = starter.interactionDots!;

    expect(dots.filter((dot) => dot.kind === "object").map((dot) => dot.targetId).sort())
      .toEqual(objects.map((object) => object.id).sort());
    expect(dots.filter((dot) => dot.kind === "emptySlot")).toEqual([]);
    expect(dots.filter((dot) => dot.kind === "deployment").map((dot) => dot.targetId))
      .toEqual(starter.extractionPoints.map((point) => point.id));
    expect(new Set(dots.map((dot) => dot.id))).toHaveLength(dots.length);
  });

  it("anchors object dots on the facing side and falls back through sides deterministically", () => {
    const facingMap = createBaseMap(starterBaseLayout, shellId);
    const object = facingMap.buildings[0].floors[0].objects[0];
    const facingDot = facingMap.interactionDots!.find((dot) => dot.targetId === object.id)!;
    const push = BOT_RADIUS + defaultGameConfig.dotRadius;
    const preferred = object.facing ?? "S";
    const preferredPosition = preferred === "N" ? { x: object.x + object.w / 2, y: object.y - push }
      : preferred === "E" ? { x: object.x + object.w + push, y: object.y + object.h / 2 }
      : preferred === "W" ? { x: object.x - push, y: object.y + object.h / 2 }
      : { x: object.x + object.w / 2, y: object.y + object.h + push };
    expect(facingDot.position).toEqual(preferredPosition);

    const fallbackMap = createBaseMap({ "floor-center": "planningTable" }, "workshop");
    const floor = fallbackMap.buildings[0].floors[0];
    const fallbackObject = floor.objects[0];
    fallbackObject.facing = "N";
    const north = { x: fallbackObject.x + fallbackObject.w / 2, y: fallbackObject.y - push };
    floor.walls.push({ id: "test-facing-block", x: north.x - 8, y: north.y - 8, w: 16, h: 16 });
    const fallbackDot = deriveBaseInteractionDots(fallbackMap).find((dot) => dot.targetId === fallbackObject.id)!;
    expect(fallbackDot.position).toEqual({
      x: fallbackObject.x + fallbackObject.w + push,
      y: fallbackObject.y + fallbackObject.h / 2,
    });
    expect(deriveBaseInteractionDots(fallbackMap)).toEqual(deriveBaseInteractionDots(fallbackMap));
  });

  it("exposes the identical slot roster as every other shell", () => {
    const roster = map.placementSlots!.map((slot) => ({ id: slot.id, zone: slot.zone }));
    for (const otherId of BASE_SHELL_IDS) {
      const other = createBaseMap(starterBaseLayout, otherId);
      expect(other.placementSlots!.map((slot) => ({ id: slot.id, zone: slot.zone }))).toEqual(roster);
    }
  });

  it("keeps the spawn and every interaction dot stand-on-able when fully furnished", () => {
    const reachable = floodReachable(world, map);
    const spawn = map.botSpawns[0];
    expect(nearestReachableDistance(spawn.position, reachable, BOT_RADIUS, map)).toBeLessThanOrEqual(BOT_RADIUS);

    for (const dot of map.interactionDots!) {
      expect(
        nearestReachableDistance(dot.position, reachable, CAPTURE_RANGE, map),
        `interaction dot ${dot.id} cannot be stood on`,
      ).toBeLessThanOrEqual(CAPTURE_RANGE);
    }
  });

  it("seals the shell: the sheet outside is unreachable on foot", () => {
    // Deployment happens at the grey dot; walking out of the base is not a
    // thing. Probe a point just beyond each shell's sealed entry plate.
    const reachable = floodReachable(world, map);
    const seal = map.buildings[0].floors[0].walls.find((wall) => wall.id.endsWith("-seal"))!;
    expect(seal, "every shell declares a sealed entry plate").toBeDefined();
    const outside = { x: seal.x + seal.w / 2, y: seal.y + seal.h + 40 };
    expect(
      nearestReachableDistance(outside, reachable, BOT_RADIUS, map),
      "the sheet outside the sealed entry must be unreachable",
    ).toBeGreaterThan(BOT_RADIUS);
  });

  it("rejects unknown slots, object kinds, and zone mismatches", () => {
    expect(() => createBaseMap({ mystery: "locker" }, shellId)).toThrow(/Unknown base placement slot/);
    expect(() => createBaseMap({ "wall-n": "not-real" } as never, shellId)).toThrow(/Unknown base object kind/);
    expect(() => createBaseMap({ "floor-center": "fabricator" }, shellId)).toThrow(/cannot be placed in floor slot/);
    expect(() => createBaseMap({ "wall-west": "repairBench", "wall-se": "repairBench" }, shellId)).toThrow(/duplicate repairBench/);
  });
});

describe.each(BASE_SHELL_IDS.map((shellId) => [shellId] as const))("expanded base map validation (%s shell)", (shellId) => {
  const map = createBaseMap(maximalExpandedBaseLayout, shellId, { expanded: true });

  it("adds one F1 plan and exposes the identical sixteen-slot roster", () => {
    expect(map.buildings[0].floors.map((floor) => floor.label)).toEqual(["GROUND", "F1"]);
    const roster = map.placementSlots!.map(({ id, zone, floor }) => ({ id, zone, floor }));
    expect(roster).toEqual(BASE_SLOT_DEFS.map(({ id, zone, floor }) => ({ id, zone, floor })));
    for (const otherId of BASE_SHELL_IDS) {
      const other = createBaseMap(maximalExpandedBaseLayout, otherId, { expanded: true });
      expect(other.placementSlots!.map(({ id, zone, floor }) => ({ id, zone, floor }))).toEqual(roster);
    }
    expect(createBaseMap(starterBaseLayout, shellId).placementSlots).toHaveLength(10);
  });

  it("pairs one walk-through stair across GROUND and F1", () => {
    const [ground, upper] = map.buildings[0].floors;
    expect(ground.stairs).toHaveLength(1);
    expect(upper.stairs).toHaveLength(1);
    expect(ground.stairs[0]).toMatchObject({ direction: "up", toFloorId: upper.id });
    expect(upper.stairs[0]).toMatchObject({ direction: "down", toFloorId: ground.id });
    expect(upper.stairs[0].rect).toEqual(ground.stairs[0].rect);
  });

  it("keeps every furnished-object and deployment interaction stand-on-able with both stair mouths reachable", () => {
    const worlds = new Map(collectFloors(map).map((world) => [world.floorId, world]));
    const reachable = new Map([...worlds].map(([floorId, world]) => [floorId, floodReachable(world, map)]));

    expect(map.interactionDots).toHaveLength(Object.keys(maximalExpandedBaseLayout).length + 1);
    for (const dot of map.interactionDots!) {
      const floorId = physicsFloorId(map, dot.floorId);
      expect(
        nearestReachableDistance(dot.position, reachable.get(floorId)!, CAPTURE_RANGE, map),
        `interaction dot ${dot.id} on ${floorId} cannot be stood on`,
      ).toBeLessThanOrEqual(CAPTURE_RANGE);
    }

    for (const [floorId, world] of worlds) {
      for (const stair of world.stairs) {
        const { entry } = stairHalves(stair);
        const point = { x: entry.x + entry.w / 2, y: entry.y + entry.h / 2 };
        expect(
          nearestReachableDistance(point, reachable.get(floorId)!, BOT_RADIUS, map),
          `stair ${stair.id} entry on ${floorId} cannot be reached`,
        ).toBeLessThanOrEqual(BOT_RADIUS);
      }
    }
  });
});
