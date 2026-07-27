import { floorPlanById, isGroundFloor } from "./mapModel";
import { solidSegments } from "./geometry";
import type { Barrier, MapDocument, Rect, Vec2 } from "./types";

/**
 * Line-of-sight geometry. One rule everywhere: only walls occlude.
 *
 * A wall may be a rect, or a barrier of capsules and hulls for geometry that
 * turns or curves; both reduce to the same segments before any ray is cast.
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
  /** Non-rectangular occluders: angled runs, curved partitions, hulls. */
  let barriers: Barrier[] = [];

  if (context === "outdoor:street") {
    wallRects = [...map.outdoor.walls, ...map.buildings.map((building) => building.footprint)];
    barriers = map.outdoor.barriers ?? [];
    boundsRect = { x: 0, y: 0, w: map.width, h: map.height };
  } else if (context.startsWith("outdoor:")) {
    const buildingId = context.slice("outdoor:".length);
    const building = map.buildings.find((item) => item.id === buildingId);
    const ground = building?.floors.find(isGroundFloor);
    wallRects = ground?.walls ?? [];
    barriers = ground?.barriers ?? [];
    boundsRect = building?.footprint ?? { x: 0, y: 0, w: map.width, h: map.height };
  } else {
    const plan = floorPlanById(map, context);
    const building = plan ? map.buildings.find((item) => item.floors.some((floor) => floor.id === plan.id)) : null;
    wallRects = plan?.walls ?? [];
    barriers = plan?.barriers ?? [];
    boundsRect = building?.footprint ?? { x: 0, y: 0, w: map.width, h: map.height };
  }

  const result: VisionContext = {
    walls: [
      ...wallRects.flatMap(rectSegments),
      ...barriers.flatMap((barrier) => barrier.solids.flatMap(solidSegments)),
    ],
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
export function hasLineOfSight(
  map: MapDocument,
  context: string,
  a: Vec2,
  b: Vec2,
  dynamicOccluders: readonly Rect[] = [],
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = Math.hypot(dx, dy);

  if (span < 1e-6) {
    return true;
  }

  for (const wall of [
    ...visionContext(map, context).walls,
    ...dynamicOccluders.flatMap(rectSegments),
  ]) {
    const t = raySegment(a.x, a.y, dx, dy, wall);

    if (t !== null && t > 1e-6 && t < 1 - 1e-6) {
      return false;
    }
  }

  return true;
}

/**
 * How close two consecutive vertices have to be before one of them is noise.
 *
 * The corner rays are offset by a fixed *angle*, so the two points either side of
 * a corner land `distance * 1e-4` apart — a fraction of a unit, well under a pixel
 * at any play zoom. Where the offset rays hit the same surface, which is most of
 * them, that leaves a pair of all-but-identical vertices, and a polygon made of
 * hundreds of zero-area slivers is one no tessellator handles the same way twice.
 * Nothing real in this world has two corners a quarter-unit apart — the thinnest
 * wall is eight — so collapsing them costs no shape.
 */
const VERTEX_MERGE = 0.25;

/**
 * Visibility polygon from an origin: rays cast at every occluder corner
 * (plus epsilon offsets), clipped to the nearest wall or the arena bounds.
 */
export function visibilityPolygon(origin: Vec2, context: VisionContext, dynamicOccluders: readonly Rect[] = []): Vec2[] {
  /**
   * Nothing you are standing inside can occlude you.
   *
   * A door's collision rect is an occluder, and a bot is briefly inside one every
   * time a door closes on it — collision pushes the bot clear, but `blocking` turns
   * on first. Treating that rect as an occluder walls the bot inside a 56x12 box
   * and the floor goes dark for a frame or two.
   */
  const blinding = dynamicOccluders.filter((rect) =>
    origin.x > rect.x && origin.x < rect.x + rect.w && origin.y > rect.y && origin.y < rect.y + rect.h);
  const occluders = blinding.length
    ? dynamicOccluders.filter((rect) => !blinding.includes(rect))
    : dynamicOccluders;
  const segments = [...context.walls, ...occluders.flatMap(rectSegments), ...context.bounds];
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

      /**
       * A hit at the origin is not an occlusion — it is the surface being stood
       * on, and `hasLineOfSight` has always rejected it for the same reason.
       * Without this, an origin that lands on an occluder makes every ray return
       * zero and the polygon collapses to a point; the renderer reads that as "see
       * everything" and the whole floor flashes lit for a frame. It is reachable,
       * because door collision rects are occluders and a bot stands inside one
       * while walking through the opening.
       */
      if (t !== null && t > 1e-6 && t < nearest) {
        nearest = t;
      }
    }

    points.push({ angle, x: origin.x + dx * nearest, y: origin.y + dy * nearest });
  }

  points.sort((a, b) => a.angle - b.angle);

  const polygon: Vec2[] = [];
  for (const point of points) {
    const last = polygon.at(-1);
    if (last && Math.abs(last.x - point.x) < VERTEX_MERGE && Math.abs(last.y - point.y) < VERTEX_MERGE) continue;
    polygon.push({ x: point.x, y: point.y });
  }
  // The seam closes too, so the wrap-around pair cannot leave a sliver either.
  const first = polygon[0];
  const last = polygon.at(-1);
  if (polygon.length > 3 && first && last
    && Math.abs(first.x - last.x) < VERTEX_MERGE && Math.abs(first.y - last.y) < VERTEX_MERGE) {
    polygon.pop();
  }
  return polygon;
}
