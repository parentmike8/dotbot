import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { BASE_GROUND_SLOT_DEFS, BASE_SHELL_IDS, BASE_SLOT_DEFS, BASE_UPPER_SLOT_DEFS, createBaseMap, deriveBaseInteractionDots, starterBaseLayout, validateBaseLayout } from "./content/base";
import { interactionDotReach } from "./interactions";
import type { BaseLayout } from "./types";
import { BLOB_KINDS, isGroundFloor, objectCollisionRects, physicsFloorId, ROUND_KINDS, stairExitPoint, stairHalves } from "./mapModel";
import { objectSolids } from "./collision";
import { pointToSolidDistanceSquared } from "./geometry";
import { auditDotPlacement, auditBuildingFloorQuality, type FloorQualityIssue } from "./mapQuality";
import { FLAT_KINDS, isSolidObject } from "./mapModel";
import { findNavigationPath } from "./navigation";
import { DotBotSimulation } from "./simulation";
import { quaysideMap } from "./content/quaysideDepot";
import { worldMap } from "./content/world";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Doorway, MapDocument, MapObject, Rect, StairLink, Vec2 } from "./types";

/**
 * Every solid object footprint standing in a doorway's threshold, on any floor.
 *
 * The corridor is as wide as the opening and 14 units deep either side: the rule
 * is the THRESHOLD, not the approach. See the downtown test that first used this
 * for why a full approach depth on both sides is the wrong demand — an 88x68 WC
 * with a 56-unit door cannot give it, and requiring it means bathrooms with
 * nothing in them. Getting from the gap to somewhere useful is the flood-fill
 * checks' job.
 */
function doorwayBlockers(map: MapDocument): string[] {
  const APPROACH = 14;
  const blockers = new Set<string>();
  const floors = new Map<string, MapObject[]>();
  const add = (floorId: string, objects: readonly MapObject[]) => {
    const pool = floors.get(floorId) ?? [];
    pool.push(...objects.filter(isSolidObject));
    floors.set(floorId, pool);
  };
  add(OUTDOOR_FLOOR_ID, map.outdoor.objects);
  for (const building of map.buildings) {
    for (const floor of building.floors) add(physicsFloorId(map, floor.id), floor.objects);
  }

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      const floorId = physicsFloorId(map, floor.id);
      for (const doorway of floor.doorways) {
        const half = doorway.width / 2;
        const corridor: Rect = doorway.dir === "h"
          ? { x: doorway.x - half, y: doorway.y - APPROACH, w: doorway.width, h: APPROACH * 2 }
          : { x: doorway.x - APPROACH, y: doorway.y - half, w: APPROACH * 2, h: doorway.width };
        for (const object of floors.get(floorId) ?? []) {
          for (const rect of objectCollisionRects(object)) {
            const overlapX = Math.min(corridor.x + corridor.w, rect.x + rect.w) - Math.max(corridor.x, rect.x);
            const overlapY = Math.min(corridor.y + corridor.h, rect.y + rect.h) - Math.max(corridor.y, rect.y);
            if (overlapX > 0 && overlapY > 0) {
              blockers.add(`${object.id} blocks ${doorway.id} (${doorway.x},${doorway.y}) on ${floorId}`);
            }
          }
        }
      }
    }
  }
  return [...blockers].sort();
}

/**
 * Solid objects standing in the APPROACH to a building's outside entrance.
 *
 * `doorwayBlockers` deliberately checks the threshold only, and its comment says
 * why: an 88x68 WC with a 56-unit door cannot give a bot's full approach depth on
 * both sides, so demanding it means bathrooms with nothing in them. That reasoning
 * is sound for a door between two rooms and wrong for the way into a building.
 *
 * Reported from play, twice in one message: "you have objects blocking entrances
 * in the octagon", "the sign at the north entrance doesn't let me get there". Both
 * cleared the threshold band and sat just past it, squarely in the line you walk.
 * An entrance is the one door whose whole job is to be walked through, and it is
 * approached across open ground where nothing needs to be tucked in tight, so it
 * gets a bot's full diameter of clear run on both sides.
 *
 * Only perimeter doorways: an entrance is one on the shell, which is where a
 * player crosses from the street into the building.
 */
function entranceApproachBlockers(map: MapDocument): string[] {
  const DEPTH = BOT_RADIUS * 2;
  const ON_SHELL = 26;
  const found = new Set<string>();

  for (const building of map.buildings) {
    const fp = building.footprint;
    const ground = building.floors.find(isGroundFloor);
    if (!ground) continue;
    const floorId = physicsFloorId(map, ground.id);
    const pool = [
      ...map.outdoor.objects.filter(isSolidObject),
      ...building.floors
        .filter((floor) => physicsFloorId(map, floor.id) === floorId)
        .flatMap((floor) => floor.objects.filter(isSolidObject)),
    ];

    for (const doorway of ground.doorways) {
      const onShell =
        Math.abs(doorway.y - fp.y) < ON_SHELL ||
        Math.abs(doorway.y - (fp.y + fp.h)) < ON_SHELL ||
        Math.abs(doorway.x - fp.x) < ON_SHELL ||
        Math.abs(doorway.x - (fp.x + fp.w)) < ON_SHELL;
      if (!onShell) continue;

      const half = doorway.width / 2;
      const corridor: Rect = doorway.dir === "h"
        ? { x: doorway.x - half, y: doorway.y - DEPTH, w: doorway.width, h: DEPTH * 2 }
        : { x: doorway.x - DEPTH, y: doorway.y - half, w: DEPTH * 2, h: doorway.width };

      for (const object of pool) {
        for (const rect of objectCollisionRects(object)) {
          const overlapX = Math.min(corridor.x + corridor.w, rect.x + rect.w) - Math.max(corridor.x, rect.x);
          const overlapY = Math.min(corridor.y + corridor.h, rect.y + rect.h) - Math.max(corridor.y, rect.y);
          if (overlapX > 0 && overlapY > 0) {
            found.add(`${object.id} stands in the approach to ${building.id}'s ${doorway.id} (${Math.round(doorway.x)},${Math.round(doorway.y)})`);
          }
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Gates in outdoor wall runs, and whether a bot can still fit through them.
 *
 * A gap in a run of collinear wall segments is a gate, and it is the ONLY way
 * through the wall it interrupts — there is no second route the way there is round
 * a piece of furniture. Two of The Reach's three were plugged by their own
 * scenery: a wagon abandoned in the middle of a 140-wide gate left two 33-unit
 * slots, and the yard's only route to the temple went through it.
 *
 * Measured as the widest remaining clear lane, not as "does anything overlap".
 * Something standing in a gateway is fine if you can still walk past it, and a
 * wagon stopped at the gate is the story that gate is telling.
 */
function gateWidths(map: MapDocument): Array<{ where: string; clear: number }> {
  const runs = new Map<string, Rect[]>();
  for (const wall of map.outdoor.walls) {
    const vertical = wall.h > wall.w;
    const key = vertical ? `v|${wall.x}|${wall.w}` : `h|${wall.y}|${wall.h}`;
    runs.set(key, [...(runs.get(key) ?? []), wall]);
  }

  const solids = map.outdoor.objects.filter(isSolidObject).flatMap(objectCollisionRects);
  const gates: Array<{ where: string; clear: number }> = [];

  for (const [key, group] of runs) {
    if (group.length < 2) continue;
    const vertical = key.startsWith("v");
    const sorted = [...group].sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const before = sorted[i];
      const after = sorted[i + 1];
      const from = vertical ? before.y + before.h : before.x + before.w;
      const to = vertical ? after.y : after.x;
      if (to - from < 8) continue; // segments touching, not a gate

      // Everything blocking the gate, projected onto the gate's own axis.
      const band = vertical
        ? { lo: before.x - BOT_RADIUS, hi: before.x + before.w + BOT_RADIUS }
        : { lo: before.y - BOT_RADIUS, hi: before.y + before.h + BOT_RADIUS };
      const spans: Array<[number, number]> = [];
      for (const rect of solids) {
        const acrossLo = vertical ? rect.x : rect.y;
        const acrossHi = vertical ? rect.x + rect.w : rect.y + rect.h;
        if (acrossHi <= band.lo || acrossLo >= band.hi) continue;
        const alongLo = vertical ? rect.y : rect.x;
        const alongHi = vertical ? rect.y + rect.h : rect.x + rect.w;
        if (alongHi <= from || alongLo >= to) continue;
        spans.push([Math.max(alongLo, from), Math.min(alongHi, to)]);
      }

      // Widest surviving lane between the blockers.
      spans.sort((a, b) => a[0] - b[0]);
      let clear = 0;
      let cursor = from;
      for (const [lo, hi] of spans) {
        clear = Math.max(clear, lo - cursor);
        cursor = Math.max(cursor, hi);
      }
      clear = Math.max(clear, to - cursor);
      gates.push({
        where: `${vertical ? "x" : "y"} ${vertical ? before.x : before.y}, gate ${Math.round(from)}-${Math.round(to)}`,
        clear: Math.round(clear),
      });
    }
  }
  return gates;
}

/**
 * Every map a player can actually load. The base shells are here too: they are
 * maps, they get simulations built on them, and they were as exposed as the
 * world to a map-wide cap nobody was testing against.
 */
const SHIPPED_MAPS: Array<[string, MapDocument]> = [
  ["the world", worldMap],
  ["downtown", downtownMap],
  ["quayside depot", quaysideMap],
  ...BASE_SHELL_IDS.map(
    (shellId) => [`base shell ${shellId}`, createBaseMap(starterBaseLayout, shellId)] as [string, MapDocument],
  ),
];

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
    /**
     * Down from 7 with the archive furnished, not up.
     *
     * Furnishing F2's west strip added one false aisle and the wall rule cleared two —
     * mine plus a pre-existing pair on either side of a partition. Beacon lost two the
     * same way. See `wallCrossesGap` in mapQuality.ts: three of these were never routes.
     */
    civic: { "false-aisle": 6, "solid-overlap": 1 },
    // `disconnected-area: 1` is paid off: a shelf in the F1 lounge sealed the
    // roof stair. See beaconHouse.ts for why that room holds a couch and nothing
    // else. The `stair-unreachable` rule added alongside the fix is what should
    // have caught it — the stranded region was a stair shaft, whose standable area
    // is always too small to clear MIN_DISCONNECTED_AREA.
    beacon: { "false-aisle": 5 },
  };

  it("does not call a gap an aisle when a wall crosses it", () => {
    /**
     * The rule that took this ledger down by three, stated as a test rather than trusted.
     *
     * Civic F2's archive stacks sit against the server room's west face; the room's
     * generator sits ten units inside it. Eighteen units apart, with a partition between
     * them, and neither sliver walkable. The old rule reported it, and because everything
     * inside that room is within 64 units of its west wall, no fixture could be placed
     * anywhere along a 120-unit-wide strip.
     *
     * Both halves matter, so both are asserted: the pair is silent while the wall is
     * there, and the same pair IS reported once the wall is taken away — otherwise the
     * guard could be swallowing real faults and this test would still pass.
     */
    const civic = downtownMap.buildings.find((building) => building.id === "civic")!;
    const f2 = civic.floors.find((floor) => floor.label === "F2")!;
    const pair = (issues: FloorQualityIssue[]) => issues.filter((issue) =>
      issue.kind === "false-aisle"
      && issue.message.includes("civic-f2-archive-a")
      && issue.message.includes("civic-f2-generator"));

    expect(pair(auditBuildingFloorQuality(downtownMap, "civic"))).toEqual([]);

    const withoutWall: MapDocument = {
      ...downtownMap,
      buildings: downtownMap.buildings.map((building) => building.id !== "civic" ? building : {
        ...building,
        floors: building.floors.map((floor) => floor.id !== f2.id ? floor : {
          ...floor,
          barriers: (floor.barriers ?? []).filter((barrier) => barrier.id !== "civic-server-room"),
          walls: floor.walls.filter((wall) => !wall.id?.startsWith("civic-server-room")),
        }),
      }),
    };
    expect(pair(auditBuildingFloorQuality(withoutWall, "civic")).length).toBeGreaterThan(0);
  });

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

    /**
     * ZERO. The last one went with the passable-drawing work, and its own justification
     * is what gave it away.
     *
     * The roof terrace planter was defended here as "a low kerb of soil you step over
     * rather than a box you walk into" — but nothing in the drawing said kerb. It was
     * 30x90, extruded like every other planter, casting a shadow onto the deck, which
     * is how this world promises cover. So the exemption rested on a reading of the
     * object that a player had no way to arrive at.
     *
     * Solid is also the better roof. A terrace is the most exposed ground on the map
     * and a waist-high planter is the only cover on it, so making it real turns visual
     * dressing into a reason to approach from one side rather than another. The audits
     * pass unchanged, which is the evidence that it cost nothing.
     */
    expect(Object.fromEntries([...ghosts].sort())).toEqual({});
    const total = [...ghosts.values()].reduce((sum, count) => sum + count, 0);
    expect(total, "total ghosts; this number may only go down").toBe(0);
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
    expect(doorwayBlockers(downtownMap)).toEqual([]);
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

/**
 * The checks above are written against downtown, and downtown alone. That was
 * fine while downtown *was* the game. It stopped being fine the moment a second
 * map shipped, and the cost came due twice on the same day:
 *
 *  - The Reach threw on construction, from a 16-floor cap left behind by a
 *    physics engine we no longer use. Every read-only audit passed. Nothing
 *    had ever *built* a simulation on it.
 *  - Two of its bot spawns were authored inside solid furniture, so the
 *    navigator would not plan from where they stood. There is a test for
 *    exactly that failure, written after it cost a play session — and it only
 *    ever ran on downtown.
 *
 * So these two run on every map a player can load, and a new map is covered by
 * appearing in SHIPPED_MAPS rather than by someone remembering this file.
 */
describe.each(SHIPPED_MAPS)("every shipped map, not just the regression map: %s", (_name, map) => {
  /**
   * The cheapest possible version of pressing W: construct the thing, then tick
   * it. A map nobody can instantiate is not a map.
   *
   * The timeout is explicit because the default 5s is not enough and this test
   * sat right on the boundary — it passed alone and failed under the parallel
   * suite. That marginality is itself the finding: The Reach costs ~1.7s to
   * prewarm and ~15ms a tick against a 16.7ms budget, nearly all of it A*. See
   * the note in `steerBotAlongPath` about what makes a replan expensive.
   */
  it("builds a live simulation and ticks it", { timeout: 30_000 }, async () => {
    const sim = await DotBotSimulation.create({ map, config: defaultGameConfig });
    expect(sim.getSnapshot().bots.length).toBeGreaterThan(0);

    for (let tick = 0; tick < 30; tick += 1) sim.step();
    const after = sim.getSnapshot();
    expect(after.timeMs).toBeGreaterThan(0);
    // Nothing may be flung off the sheet by its own first half-second alive.
    for (const bot of after.bots) {
      expect(Number.isFinite(bot.position.x) && Number.isFinite(bot.position.y)).toBe(true);
      expect(bot.position.x).toBeGreaterThanOrEqual(0);
      expect(bot.position.y).toBeGreaterThanOrEqual(0);
      expect(bot.position.x).toBeLessThanOrEqual(map.width);
      expect(bot.position.y).toBeLessThanOrEqual(map.height);
    }
    sim.dispose();
  });

  /**
   * Bots have to actually GET somewhere, which no other test in this file asks.
   *
   * A* is rationed: one bot may plan per tick, because several searches landing
   * in one frame was a 50-100ms freeze every couple of seconds. Rationing is
   * exactly the kind of optimisation that can starve the thing it rations, and
   * the failure would be silent — bots standing about, every audit still green,
   * nothing in the suite the wiser. So this measures the outcome the rationing
   * risks rather than the mechanism.
   *
   * Thresholds are deliberately loose. The floor is total paralysis, not slow
   * progress: a bot on the signal box's operating floor covers 16 units in three
   * seconds because the room is 300 wide, and that is correct behaviour.
   */
  it("gets every AI bot moving within three seconds", { timeout: 30_000 }, async () => {
    const sim = await DotBotSimulation.create({ map, config: defaultGameConfig });
    const from = new Map(sim.getSnapshot().bots.map((bot) => [bot.id, { ...bot.position }]));
    for (let tick = 0; tick < 180; tick += 1) sim.step();

    const travelled = sim
      .getSnapshot()
      .bots.filter((bot) => bot.id !== "player" && from.has(bot.id))
      .map((bot) => {
        const start = from.get(bot.id)!;
        return { id: bot.id, moved: Math.hypot(bot.position.x - start.x, bot.position.y - start.y) };
      });
    sim.dispose();
    // The base shells ship the player alone; there is nothing here to assert.
    if (travelled.length === 0) return;

    expect(travelled.filter((bot) => bot.moved < 10).map((bot) => bot.id), "these bots never moved at all").toEqual([]);

    const median = travelled.map((bot) => bot.moved).sort((a, b) => a - b)[Math.floor(travelled.length / 2)];
    expect(median, "the typical bot barely moved — planning is probably being starved").toBeGreaterThan(120);
  });

  /**
   * The same probe as "keeps every bot spawn somewhere the navigator can plan
   * FROM", asked of every map. See that test for why it asks the shipped
   * pathfinder rather than this file's own coarse flood, and why it probes at
   * 60 units rather than further out.
   *
   * A wedged spawn is not only a bot that never moves. `steerBotAlongPath`
   * zeroes its repath timer whenever a plan comes back empty, so a wedged bot
   * re-runs the most expensive search there is — an exhaustive one that
   * explores its whole component before failing — every single tick, forever.
   * Two of them on The Reach cost 12ms of a 16.7ms budget: the map was
   * unplayable for a reason no read-only audit could see.
   */
  /**
   * Reported from play, with a screenshot: "you have objects blocking entrances in
   * the octagon — the sign at the north entrance doesn't let me get there."
   *
   * There is a test for exactly this, written the last time it happened, with the
   * appropriate amount of laughter recorded in its comment. Like every other
   * navigation check in this file it ran on downtown alone, so the four regions
   * shipped with no threshold checking at all. Same lesson as the wedged spawns
   * and the floor cap, for the third time in one day: a check that names a real
   * failure is worthless if it only ever looks at one map.
   */
  it("keeps the walking line through every doorway clear of solid objects", () => {
    expect(doorwayBlockers(map)).toEqual([]);
  });

  it("keeps a bot's full diameter of clear run either side of every entrance", () => {
    expect(entranceApproachBlockers(map)).toEqual([]);
  });

  /**
   * A ROUND OBJECT COLLIDES AS A ROUND OBJECT, and never as anything larger.
   *
   * Third attempt at this, so it gets a check rather than a comment. The bounding
   * box came first, and the corner of a 310-wide carousel was 45 units of solid
   * ground you could see straight through. Then eight stepped bands, each sized at
   * its widest point so the stack would contain the circle — which circumscribed
   * it, standing slabs off the top and bottom, and was reported the same way: "a
   * square protruding from the merry go round." It is a real disc now.
   *
   * The assertion is one-directional on purpose. Sampling just OUTSIDE the drawn
   * radius must be clear, because a collider the player cannot see is the failure
   * both earlier attempts shipped; a few units of slack on the inside would be
   * invisible and is not worth testing for.
   */
  it("never puts collision outside the shape an inscribed object draws", () => {
    const inscribed = [
      ...map.outdoor.objects,
      ...map.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.objects)),
    ].filter(
      (object) =>
        isSolidObject(object) &&
        !object.collisionParts?.length &&
        (ROUND_KINDS.has(object.kind) || BLOB_KINDS.has(object.kind) || object.kind === "ferrisWheel"),
    );
    if (inscribed.length === 0) return;

    const offenders: string[] = [];
    for (const object of inscribed) {
      const solids = objectSolids(object);
      const cx = object.x + object.w / 2;
      const cy = object.y + object.h / 2;

      // The four corners of the bounding box. Every version of this bug has lived
      // there, and no glyph in this group draws anything in them.
      for (const corner of [
        { x: object.x + 1, y: object.y + 1 },
        { x: object.x + object.w - 1, y: object.y + 1 },
        { x: object.x + 1, y: object.y + object.h - 1 },
        { x: object.x + object.w - 1, y: object.y + object.h - 1 },
      ]) {
        if (solids.some((solid) => pointToSolidDistanceSquared(corner, solid) <= 0)) {
          offenders.push(`${object.id} (${object.kind}) is solid in its bounding-box corner`);
        }
      }

      // And for a disc, the whole ring just outside the drawn rim.
      if (ROUND_KINDS.has(object.kind)) {
        const radius = Math.min(object.w, object.h) / 2;
        for (let step = 0; step < 64; step += 1) {
          const angle = (step / 64) * Math.PI * 2;
          const at = { x: cx + Math.cos(angle) * (radius + 2), y: cy + Math.sin(angle) * (radius + 2) };
          if (solids.some((solid) => pointToSolidDistanceSquared(at, solid) <= 0)) {
            offenders.push(`${object.id} (${object.kind}) is solid outside its own rim`);
          }
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * A gate is the only hole in the wall it interrupts, so it may never be narrowed
   * below a bot's diameter plus slack. Two of The Reach's three were plugged.
   */
  it("leaves every gate in an outdoor wall wide enough to walk through", () => {
    const MIN = BOT_RADIUS * 2 + 16;
    const tight = gateWidths(map)
      .filter((gate) => gate.clear < MIN)
      .map((gate) => `${gate.where} — only ${gate.clear} clear, needs ${MIN}`);
    expect(tight).toEqual([]);
  });

  it("keeps every bot spawn somewhere the navigator can plan FROM", () => {
    // Every wedged spawn, not just the first. Stopping at one turns a single
    // authoring pass into as many round trips as there are mistakes.
    const wedged: string[] = [];
    for (const spawn of map.botSpawns) {
      const floorId = spawn.floorId ?? OUTDOOR_FLOOR_ID;
      let planned = 0;
      for (let step = 0; step < 8; step += 1) {
        const angle = (step / 8) * Math.PI * 2;
        const goal = {
          x: spawn.position.x + Math.cos(angle) * 60,
          y: spawn.position.y + Math.sin(angle) * 60,
        };
        if (findNavigationPath(map, floorId, spawn.position, goal, BOT_RADIUS).length > 0) planned += 1;
      }
      if (planned === 0) wedged.push(`${spawn.id} at (${spawn.position.x}, ${spawn.position.y}) on ${floorId}`);
    }
    expect(
      wedged,
      `these bots are wedged: the navigator cannot plan a path from where they stand, in any`
        + ` direction, so they will never move — and each re-runs a failed exhaustive search every tick`,
    ).toEqual([]);
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
