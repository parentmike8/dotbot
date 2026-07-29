import { pointToSolidDistanceSquared, rectSolid } from "./geometry";
import { interactionDotReach } from "./interactions";
import { isGroundFloor, MIN_DOT_SEPARATION, objectCollisionRects, rectContains, stairHalves } from "./mapModel";
import type { Building, DotSpawn, FloorPlan, MapDocument, MapObject, Rect, Solid, Vec2 } from "./types";

const PUSH_CLEARANCE = 10;
const reachabilityCache = new WeakMap<MapDocument, Map<string, Reachability>>();

type Reachability = { cell: number; cols: number; rows: number; reachable: Set<number> };

/** Everything on a floor that blocks a bot, rect walls and path walls alike. */
function floorSolids(floor: FloorPlan): Solid[] {
  return [
    ...floor.walls.map(rectSolid),
    ...(floor.barriers ?? []).flatMap((barrier) => barrier.solids),
  ];
}

/**
 * Deterministically add one blueprint for every scannable object type in each
 * building. Each spawn sits at the midpoint of the object's most-open side,
 * with a bot-radius clearance from solid geometry.
 *
 * Returns a new document. Buildings compiled from map source are module-level
 * constants that more than one map can include, so pushing spawns into their
 * floors would decorate every map that shares them — and decorate them twice if
 * the document were ever built again.
 */
export function addBlueprintSpawns(map: MapDocument, botRadius: number): MapDocument {
  const buildings = map.buildings.map((building) => {
    const seen = new Set<string>();
    const floors = building.floors.map((floor) => {
      /**
       * Accumulated as we go, and seeded with the floor's authored Dots.
       *
       * Without this the placer stacked blueprints on top of authored Dots: both
       * are drawn to the same thing — the interesting, scannable object — so a
       * blueprint for the pharmacy shelf landed 5.7 units from the Dot already
       * beside it. Two Dots in the same place is one pickup and one wasted slot.
       */
      const placed: Vec2[] = floor.dotSpawns.map((dot) => dot.position);
      const added: DotSpawn[] = [];
      for (const object of floor.objects) {
        if (!object.scannable || seen.has(object.kind)) continue;
        seen.add(object.kind);
        const position = mostOpenSide(map, building, floor, object, botRadius, placed);
        placed.push(position);
        added.push({
          id: `blueprint-${building.id}-${object.kind}`,
          item: { kind: "blueprint" as const, blueprintId: object.kind },
          position,
        });
      }
      return added.length ? { ...floor, dotSpawns: [...floor.dotSpawns, ...added] } : floor;
    });
    return { ...building, floors };
  });
  return { ...map, buildings };
}

function mostOpenSide(
  map: MapDocument,
  building: Building,
  floor: FloorPlan,
  object: MapObject,
  botRadius: number,
  placed: readonly Vec2[],
): Vec2 {
  const clearOfDots = (position: Vec2): boolean => placed.every((other) =>
    Math.hypot(other.x - position.x, other.y - position.y) >= MIN_DOT_SEPARATION);
  /**
   * Not on the far side of a flight, which is open floor a bot can never occupy.
   *
   * `isReachable` floods the solids and calls the exit half reachable, because it IS — there
   * is nothing solid there and the navigator will happily route through it. What it cannot
   * know is that `resolveStairs` swaps floor on the way in, so the step that would land a bot
   * there lands it on the other floor instead. This placer put `blueprint-mercy-locker` past
   * the break line of `mercy-stair-up` and it was uncollectable from the day it shipped.
   *
   * Fixed in the placer rather than in a coordinate, because nothing here is authored: a
   * blueprint goes to the most open side of its object, so moving the locker or adding a
   * fixture beside it can put the spawn back on the stair at any time.
   */
  const offTheFarSideOfAStair = (position: Vec2): boolean =>
    floor.stairs.every((stair) => !rectContains(stairHalves(stair).exit, position));
  const solids: Solid[] = [
    ...floorSolids(floor),
    ...floor.objects.filter((candidate) => candidate.id !== object.id).flatMap(objectCollisionRects).map(rectSolid),
    ...(isGroundFloor(floor)
      ? [
          ...map.outdoor.walls.map(rectSolid),
          ...map.outdoor.objects.flatMap(objectCollisionRects).map(rectSolid),
          ...(map.outdoor.barriers ?? []).flatMap((barrier) => barrier.solids),
        ]
      : []),
  ];
  const distanceFromEdge = botRadius + PUSH_CLEARANCE;
  const candidates: Vec2[] = [
    { x: object.x + object.w / 2, y: object.y - distanceFromEdge },
    { x: object.x + object.w + distanceFromEdge, y: object.y + object.h / 2 },
    { x: object.x + object.w / 2, y: object.y + object.h + distanceFromEdge },
    { x: object.x - distanceFromEdge, y: object.y + object.h / 2 },
  ];
  const valid = candidates
    .map((position, order) => ({
      position,
      order,
      score: isReachable(map, floor, position, botRadius) && clearOfDots(position)
        && offTheFarSideOfAStair(position)
        ? openness(position, building.footprint, solids, botRadius)
        : Number.NEGATIVE_INFINITY,
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  if (valid[0]) return valid[0].position;

  // Authored scenery can make the first ring tight. Expand along the same
  // deterministic side order until a bot-clear point exists.
  // Widened from 96: the separation constraint rules out more of the first ring
  // than clearance alone did, and a crowded floor needs further to walk.
  for (let extra = 8; extra <= 200; extra += 8) {
    for (const position of candidates) {
      const direction = {
        x: Math.sign(position.x - (object.x + object.w / 2)),
        y: Math.sign(position.y - (object.y + object.h / 2)),
      };
      const expanded = { x: position.x + direction.x * extra, y: position.y + direction.y * extra };
      if (
        Number.isFinite(openness(expanded, building.footprint, solids, botRadius)) &&
        isReachable(map, floor, expanded, botRadius) &&
        clearOfDots(expanded) &&
        offTheFarSideOfAStair(expanded)
      ) return expanded;
    }
  }
  throw new Error(`No bot-clear blueprint spawn for ${building.id}/${floor.id}/${object.kind}`);
}

function isReachable(map: MapDocument, floor: FloorPlan, position: Vec2, botRadius: number): boolean {
  const seed = floor.dotSpawns[0]?.position;
  if (!seed) return false;
  const cell = 8;
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const cacheKey = isGroundFloor(floor) ? "outdoor" : floor.id;
  const mapCache = reachabilityCache.get(map) ?? new Map<string, Reachability>();
  reachabilityCache.set(map, mapCache);
  let cached = mapCache.get(cacheKey);
  const solids: Solid[] = isGroundFloor(floor)
    ? [
        ...map.outdoor.walls.map(rectSolid),
        ...map.outdoor.objects.flatMap(objectCollisionRects).map(rectSolid),
        ...(map.outdoor.barriers ?? []).flatMap((barrier) => barrier.solids),
        ...map.buildings.flatMap((candidate) => candidate.floors.filter(isGroundFloor)
          .flatMap((plan) => [...floorSolids(plan), ...plan.objects.flatMap(objectCollisionRects).map(rectSolid)])),
      ]
    : [...floorSolids(floor), ...floor.objects.flatMap(objectCollisionRects).map(rectSolid)];
  const center = (index: number): Vec2 => ({
    x: (index % cols) * cell + cell / 2,
    y: Math.floor(index / cols) * cell + cell / 2,
  });
  const open = (index: number) => {
    const point = center(index);
    if (point.x < botRadius || point.y < botRadius || point.x > map.width - botRadius || point.y > map.height - botRadius) return false;
    return solids.every((solid) => pointToSolidDistanceSquared(point, solid) >= (botRadius - 1) ** 2);
  };
  const captureRange = interactionDotReach(botRadius, 10);
  const nearestOpen = (point: Vec2): number[] => {
    const span = Math.ceil((captureRange + cell) / cell);
    const col = Math.floor(point.x / cell);
    const row = Math.floor(point.y / cell);
    const matches: number[] = [];
    for (let dy = -span; dy <= span; dy += 1) {
      for (let dx = -span; dx <= span; dx += 1) {
        const c = col + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const index = r * cols + c;
        const pointCenter = center(index);
        if (Math.hypot(pointCenter.x - point.x, pointCenter.y - point.y) <= captureRange && open(index)) matches.push(index);
      }
    }
    return matches;
  };
  if (!cached) {
    const starts = nearestOpen(seed);
    const reachable = new Set(starts);
    const queue = [...starts];
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
    cached = { cell, cols, rows, reachable };
    mapCache.set(cacheKey, cached);
  }
  return nearestOpen(position).some((index) => cached!.reachable.has(index));
}

function openness(position: Vec2, bounds: Rect, solids: Solid[], botRadius: number): number {
  if (
    position.x < bounds.x + botRadius || position.x > bounds.x + bounds.w - botRadius ||
    position.y < bounds.y + botRadius || position.y > bounds.y + bounds.h - botRadius
  ) return Number.NEGATIVE_INFINITY;

  let best = Math.min(
    position.x - bounds.x,
    bounds.x + bounds.w - position.x,
    position.y - bounds.y,
    bounds.y + bounds.h - position.y,
  );
  for (const solid of solids) {
    const clearance = Math.sqrt(pointToSolidDistanceSquared(position, solid));
    if (clearance < botRadius) return Number.NEGATIVE_INFINITY;
    best = Math.min(best, clearance);
  }
  return best;
}
