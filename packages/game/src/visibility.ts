import { floorPlanById, isGroundFloor } from "./mapModel";
import type { MapDocument, Rect, Vec2 } from "./types";

/**
 * Line-of-sight geometry. One rule everywhere: only walls occlude.
 * Indoors that means the floor's wall segments; on the street, whole
 * building footprints block vision (you cannot see through a building).
 */

export type Segment = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
};

export type VisionContext = {
  /** Occluding wall segments — used for both the polygon and LOS tests. */
  walls: Segment[];
  /** Arena boundary segments — rays terminate here. */
  bounds: Segment[];
  boundsRect: Rect;
};

const contextCache = new WeakMap<MapDocument, Map<string, VisionContext>>();

function rectSegments(rect: Rect): Segment[] {
  const { x, y, w, h } = rect;
  return [
    { ax: x, ay: y, bx: x + w, by: y },
    { ax: x + w, ay: y, bx: x + w, by: y + h },
    { ax: x + w, ay: y + h, bx: x, by: y + h },
    { ax: x, ay: y + h, bx: x, by: y },
  ];
}

/**
 * Occluders and bounds for an arena context key (see mapModel.contextKey):
 * "outdoor:street", "outdoor:<buildingId>", or an interior floor id.
 */
export function visionContext(map: MapDocument, context: string): VisionContext {
  let byContext = contextCache.get(map);

  if (!byContext) {
    byContext = new Map();
    contextCache.set(map, byContext);
  }

  const cached = byContext.get(context);

  if (cached) {
    return cached;
  }

  let wallRects: Rect[];
  let boundsRect: Rect;

  if (context === "outdoor:street") {
    wallRects = [...map.outdoor.walls, ...map.buildings.map((building) => building.footprint)];
    boundsRect = { x: 0, y: 0, w: map.width, h: map.height };
  } else if (context.startsWith("outdoor:")) {
    const buildingId = context.slice("outdoor:".length);
    const building = map.buildings.find((item) => item.id === buildingId);
    const ground = building?.floors.find(isGroundFloor);
    wallRects = ground?.walls ?? [];
    boundsRect = building?.footprint ?? { x: 0, y: 0, w: map.width, h: map.height };
  } else {
    const plan = floorPlanById(map, context);
    const building = plan ? map.buildings.find((item) => item.floors.some((floor) => floor.id === plan.id)) : null;
    wallRects = plan?.walls ?? [];
    boundsRect = building?.footprint ?? { x: 0, y: 0, w: map.width, h: map.height };
  }

  const result: VisionContext = {
    walls: wallRects.flatMap(rectSegments),
    bounds: rectSegments(boundsRect),
    boundsRect,
  };

  byContext.set(context, result);
  return result;
}

/**
 * Distance along the ray (origin + t * dir) to a segment, or null if missed.
 */
function raySegment(
  px: number,
  py: number,
  dx: number,
  dy: number,
  segment: Segment,
): number | null {
  const rx = segment.bx - segment.ax;
  const ry = segment.by - segment.ay;
  const denom = dx * ry - dy * rx;

  if (Math.abs(denom) < 1e-9) {
    return null;
  }

  const t = ((segment.ax - px) * ry - (segment.ay - py) * rx) / denom;
  const u = ((segment.ax - px) * dy - (segment.ay - py) * dx) / denom;

  if (t >= 0 && u >= -1e-6 && u <= 1 + 1e-6) {
    return t;
  }

  return null;
}

/** True when the straight segment a→b crosses no occluding wall. */
export function hasLineOfSight(map: MapDocument, context: string, a: Vec2, b: Vec2): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = Math.hypot(dx, dy);

  if (span < 1e-6) {
    return true;
  }

  for (const wall of visionContext(map, context).walls) {
    const t = raySegment(a.x, a.y, dx, dy, wall);

    if (t !== null && t > 1e-6 && t < 1 - 1e-6) {
      return false;
    }
  }

  return true;
}

/**
 * Visibility polygon from an origin: rays cast at every occluder corner
 * (plus epsilon offsets), clipped to the nearest wall or the arena bounds.
 */
export function visibilityPolygon(origin: Vec2, context: VisionContext): Vec2[] {
  const segments = [...context.walls, ...context.bounds];
  const angles: number[] = [];

  for (const segment of segments) {
    for (const [ex, ey] of [
      [segment.ax, segment.ay],
      [segment.bx, segment.by],
    ]) {
      const angle = Math.atan2(ey - origin.y, ex - origin.x);
      angles.push(angle - 1e-4, angle, angle + 1e-4);
    }
  }

  const points: Array<{ angle: number; x: number; y: number }> = [];
  const maxDistance = context.boundsRect.w + context.boundsRect.h;

  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let nearest = maxDistance;

    for (const segment of segments) {
      const t = raySegment(origin.x, origin.y, dx, dy, segment);

      if (t !== null && t < nearest) {
        nearest = t;
      }
    }

    points.push({ angle, x: origin.x + dx * nearest, y: origin.y + dy * nearest });
  }

  points.sort((a, b) => a.angle - b.angle);
  return points.map((point) => ({ x: point.x, y: point.y }));
}
