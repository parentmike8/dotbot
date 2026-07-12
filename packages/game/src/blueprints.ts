import { isGroundFloor, isSolidObject } from "./mapModel";
import type { Building, FloorPlan, MapDocument, MapObject, Rect, Vec2 } from "./types";

const PUSH_CLEARANCE = 10;
const reachabilityCache = new WeakMap<MapDocument, Map<string, Reachability>>();

type Reachability = { cell: number; cols: number; rows: number; reachable: Set<number> };

/**
 * Deterministically add one blueprint for every scannable object type in each
 * building. Each spawn sits at the midpoint of the object's most-open side,
 * with a bot-radius clearance from solid geometry.
 */
export function addBlueprintSpawns(map: MapDocument, botRadius: number): MapDocument {
  for (const building of map.buildings) {
    const seen = new Set<string>();
    for (const floor of building.floors) {
      for (const object of floor.objects) {
        if (!object.scannable || seen.has(object.kind)) continue;
        const position = mostOpenSide(map, building, floor, object, botRadius);
        floor.dotSpawns.push({
          id: `blueprint-${building.id}-${object.kind}`,
          item: { kind: "blueprint", blueprintId: object.kind },
          position,
        });
        seen.add(object.kind);
      }
    }
  }
  return map;
}

function mostOpenSide(map: MapDocument, building: Building, floor: FloorPlan, object: MapObject, botRadius: number): Vec2 {
  const solids: Rect[] = [
    ...floor.walls,
    ...floor.objects.filter((candidate) => candidate.id !== object.id && isSolidObject(candidate)),
    ...(isGroundFloor(floor) ? [...map.outdoor.walls, ...map.outdoor.objects.filter(isSolidObject)] : []),
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
      score: isReachable(map, floor, position, botRadius) ? openness(position, building.footprint, solids, botRadius) : Number.NEGATIVE_INFINITY,
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  if (valid[0]) return valid[0].position;

  // Authored scenery can make the first ring tight. Expand along the same
  // deterministic side order until a bot-clear point exists.
  for (let extra = 8; extra <= 96; extra += 8) {
    for (const position of candidates) {
      const direction = {
        x: Math.sign(position.x - (object.x + object.w / 2)),
        y: Math.sign(position.y - (object.y + object.h / 2)),
      };
      const expanded = { x: position.x + direction.x * extra, y: position.y + direction.y * extra };
      if (
        Number.isFinite(openness(expanded, building.footprint, solids, botRadius)) &&
        isReachable(map, floor, expanded, botRadius)
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
  const solids = isGroundFloor(floor)
    ? [
        ...map.outdoor.walls,
        ...map.outdoor.objects.filter(isSolidObject),
        ...map.buildings.flatMap((candidate) => candidate.floors.filter(isGroundFloor)
          .flatMap((plan) => [...plan.walls, ...plan.objects.filter(isSolidObject)])),
      ]
    : [...floor.walls, ...floor.objects.filter(isSolidObject)];
  const center = (index: number): Vec2 => ({
    x: (index % cols) * cell + cell / 2,
    y: Math.floor(index / cols) * cell + cell / 2,
  });
  const open = (index: number) => {
    const point = center(index);
    if (point.x < botRadius || point.y < botRadius || point.x > map.width - botRadius || point.y > map.height - botRadius) return false;
    return solids.every((rect) => circleClearsRect(point, botRadius - 1, rect));
  };
  const captureRange = botRadius - 10 - 2;
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

function circleClearsRect(center: Vec2, radius: number, rect: Rect): boolean {
  const dx = center.x - Math.max(rect.x, Math.min(center.x, rect.x + rect.w));
  const dy = center.y - Math.max(rect.y, Math.min(center.y, rect.y + rect.h));
  return dx * dx + dy * dy >= radius * radius;
}

function openness(position: Vec2, bounds: Rect, solids: Rect[], botRadius: number): number {
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
  for (const rect of solids) {
    const dx = Math.max(rect.x - position.x, 0, position.x - (rect.x + rect.w));
    const dy = Math.max(rect.y - position.y, 0, position.y - (rect.y + rect.h));
    const clearance = Math.hypot(dx, dy);
    if (clearance < botRadius) return Number.NEGATIVE_INFINITY;
    best = Math.min(best, clearance);
  }
  return best;
}
