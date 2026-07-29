import { contextKey, floorPlanById, isGroundFloor, physicsFloorId } from "./mapModel";
import { buildingMouths } from "./entrances";
import { pointToSegmentDistanceSquared, pointToSolidDistanceSquared, rectSolid, solidSegments } from "./geometry";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Barrier, MapDocument, Rect, Solid, Vec2 } from "./types";

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
  /**
   * The solids `walls` was built from — rect walls and barrier capsules and hulls
   * alike — kept so the polygon can ask whether an origin is standing *inside*
   * one. Rebuilding the segment list without a solid is rare enough to pay for on
   * the spot.
   */
  wallSolids: Solid[];
  /** Arena boundary segments — rays terminate here. */
  bounds: Segment[];
  boundsRect: Rect;
};

const contextCache = new WeakMap<MapDocument, Map<string, VisionContext>>();

/**
 * How far inside a solid a point must be before it counts as standing *in* it.
 *
 * Strictly interior, not merely touching. A bot resting against a wall sits
 * exactly on that wall's outline, and letting contact count as containment would
 * turn every wall a player leans on into glass — the opposite failure, and a much
 * worse one than the flash this exists to prevent.
 */
const ENCLOSED_MARGIN = 0.5;

function enclosesStrictly(point: Vec2, solid: Solid): boolean {
  if (pointToSolidDistanceSquared(point, solid) > 0) return false;
  let toOutline = Infinity;
  for (const edge of solidSegments(solid)) {
    toOutline = Math.min(toOutline, pointToSegmentDistanceSquared(point, edge.ax, edge.ay, edge.bx, edge.by));
  }
  return toOutline > ENCLOSED_MARGIN * ENCLOSED_MARGIN;
}

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

  const wallSolids: Solid[] = [
    ...wallRects.map(rectSolid),
    ...barriers.flatMap((barrier) => barrier.solids),
  ];
  const result: VisionContext = {
    walls: wallSolids.flatMap(solidSegments),
    wallSolids,
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
 * The total sight budget through a doorway, SHARED between the two parties.
 *
 * Not "96 units each side", which is what this was and it jittered badly. A fixed radius
 * per party makes the granted region a step function: at 97 units away you get nothing, at
 * 95 you get the whole disc, so sliding along a wall past a door flickered the fog on and
 * off. Reported from play as exactly that — "shifting left and right in the doorway causes
 * the fog to be quite jittery".
 *
 * A shared budget removes the step. You see `DOORWAY_SIGHT - yourDistance` through the
 * gap, so the reveal grows continuously from nothing as you approach and shrinks the same
 * way as you leave. It stays symmetric, which was the point of the original rule: A sees B
 * when `db <= BUDGET - da`, B sees A when `da <= BUDGET - db`, and those are the same
 * inequality — `da + db <= BUDGET`.
 *
 * It is also the more honest model of a door. A gap in a wall is a keyhole: the closer you
 * put your eye to it the more of the far side you get, and from far enough away it tells
 * you nothing at all.
 */
export const DOORWAY_SIGHT = 180;

/**
 * How far past a mouth this viewer can see, as a RADIUS to draw.
 *
 * Shared with the renderer on purpose — it draws a disc of exactly this size, and if the
 * two ever disagreed a bot would be either invisible while targetable, or drawn through the
 * wall beside the door.
 *
 * Not the predicate, though, and the clamp is why. A radius must never go negative, but
 * `Math.max(0, …)` also destroys the symmetry it looks like it preserves: a viewer standing
 * IN the gap (distance 0) against a bot at 181 gives `181 <= 180` = false one way and
 * `0 <= max(0, -1) = 0` = true the other. A test caught it at exactly that boundary. So the
 * rule is the sum, stated once in `seesThroughDoorway`, and this is only for drawing.
 */
export function doorwayReach(distanceToMouth: number): number {
  return Math.max(0, DOORWAY_SIGHT - distanceToMouth);
}

/**
 * Whether two positions can see each other through a building's front door.
 *
 * WHY THIS EXISTS AS A SEPARATE RULE, rather than as a change to the occluders.
 *
 * Interior doorways already work and need nothing: `compileWall` cuts an opening as a
 * GENUINE GAP in the wall solids, so the polygon and `hasLineOfSight` both pass straight
 * through one. The blindness is at an ARENA boundary. `contextKey` splits the outdoor
 * plane into the street and one context per building ground floor — physically connected,
 * deliberately separate — and everything that asks "can these two interact" first asks
 * whether the context keys match. A bot on the pavement and a bot two feet inside the
 * lobby are in different arenas, so they cannot see, target or be targeted by each other
 * at all. On top of that the street's occluder list contains every building FOOTPRINT, so
 * even within one context vision stops dead at an elevation with no gap at the door.
 *
 * The result is that camping an exit is not merely favourable, it is airtight: the camper
 * knows where the door is and the player coming out gets no warning whatsoever. That is
 * the asymmetry this closes, and it closes it BOTH WAYS on purpose — the bot inside sees
 * the patch of street outside its door, and the bot outside sees into the mouth.
 *
 * Proximity to a shared mouth is the whole test, with no line-of-sight check after it.
 * That is deliberate: within 96 units either side of a door there is nothing to hide
 * behind that ought to save you, and a ray test here would reintroduce the same problem
 * one step further in, because the two sides do not share an occluder list. Loud and
 * simple beats subtle and half-working for a rule whose entire job is to deny a hiding
 * place.
 */
export function seesThroughDoorway(
  map: MapDocument,
  aFloorId: string,
  a: Vec2,
  bFloorId: string,
  b: Vec2,
): boolean {
  // Only the outdoor plane has two contexts touching. Upper floors are separated by a
  // storey, not by a wall with a hole in it.
  if (physicsFloorId(map, aFloorId) !== OUTDOOR_FLOOR_ID) return false;
  if (physicsFloorId(map, bFloorId) !== OUTDOOR_FLOOR_ID) return false;

  const aContext = contextKey(map, aFloorId, a);
  const bContext = contextKey(map, bFloorId, b);
  // Same arena already sees normally; this rule is only for the boundary.
  if (aContext === bContext) return false;

  for (const context of [aContext, bContext]) {
    if (!context.startsWith("outdoor:") || context === "outdoor:street") continue;
    for (const mouth of buildingMouths(map, context.slice("outdoor:".length))) {
      const da = Math.hypot(a.x - mouth.x, a.y - mouth.y);
      if (da >= DOORWAY_SIGHT) continue;
      // The sum, not `db <= doorwayReach(da)` — see `doorwayReach` for why the clamp in it
      // makes that subtly asymmetric at the boundary.
      if (da + Math.hypot(b.x - mouth.x, b.y - mouth.y) <= DOORWAY_SIGHT) return true;
    }
  }
  return false;
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
 * How far a vertex may sit off the line through its neighbours before it is real.
 *
 * Distance-merging alone left the polygon churning. It is a hard cutoff, so as the
 * origin moves, pairs drift across it and vertices pop in and out — measured over
 * a strafe across Mercy Clinic, the vertex count changed on 227 of 799 quarter-unit
 * steps while the lit *area* held to within 0.07%. The shape was right and the
 * triangulation was different every few frames, which is precisely the crawl the
 * merge was added to stop.
 *
 * Collinearity has no such cutoff to drift across. The slivers this is aimed at are
 * pairs of rays that hit the *same wall*, so they are exactly collinear with the
 * run they sit on, at any origin — a vertex mid-wall is redundant whether the
 * player is a unit away or a hundred. Vertices at real corners are never near
 * collinear and always survive.
 */
const COLLINEAR_TOLERANCE = 0.05;

/**
 * Drop vertices that lie on the line through their neighbours.
 *
 * Runs after the distance merge rather than instead of it: exact duplicates have
 * no line to be collinear with, so they still need their own rule.
 */
function dropCollinear(polygon: Vec2[]): Vec2[] {
  if (polygon.length < 4) return polygon;
  const kept: Vec2[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const previous = kept.at(-1) ?? polygon[(index - 1 + polygon.length) % polygon.length];
    const point = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const ax = point.x - previous.x;
    const ay = point.y - previous.y;
    const bx = next.x - previous.x;
    const by = next.y - previous.y;
    const span = Math.hypot(bx, by);
    // Perpendicular distance from the point to the chord its neighbours span.
    const offset = span < 1e-9 ? Math.hypot(ax, ay) : Math.abs(ax * by - ay * bx) / span;
    if (offset > COLLINEAR_TOLERANCE) kept.push(point);
  }
  // Never simplify a polygon out of existence: three vertices is the floor, and
  // `updateLineOfSight` reads anything under it as "no occlusion at all".
  return kept.length >= 3 ? kept : polygon;
}

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
  const contains = (rect: Rect): boolean =>
    origin.x > rect.x && origin.x < rect.x + rect.w && origin.y > rect.y && origin.y < rect.y + rect.h;

  const blinding = dynamicOccluders.filter(contains);
  const occluders = blinding.length
    ? dynamicOccluders.filter((rect) => !blinding.includes(rect))
    : dynamicOccluders;

  /**
   * The same rule, applied to static walls — which is where it was missing.
   *
   * The escape above was written for doors, because a bot is inside a door rect
   * every time one closes on it. Walls were left out on the assumption that a
   * bot's own radius keeps its centre out of them. That assumption does not hold
   * for the origin this is actually called with: the renderer casts from the
   * *rendered* position, which is the predicted position plus a reconciliation
   * offset applied after collision — so a correction can put the origin inside a
   * wall while the simulated bot is nowhere near one.
   *
   * The failure is total rather than subtle. Standing inside Lot 6's eight-unit
   * partition, every ray hits that partition from the inside and the polygon
   * becomes the wall's own interior: an 8 x 92 sliver, and the floor's lit area
   * drops from 210559 to 710 within a unit of travel. That is a black flash
   * across a whole room, and corrections happen exactly when you are moving.
   *
   * Tested against solids rather than rects, because the partition that found
   * this is a *barrier* — a first attempt checked only rect walls and did not
   * fire on it at all.
   *
   * Straight about what this buys: it converts a black flash into a bright one,
   * not into nothing. An origin inside a wall is already a state with no right
   * answer, and seeing too much for a frame is far less alarming than the room
   * going dark. The actual cure is for the rendered origin never to be inside a
   * wall in the first place; this is the net under that.
   */
  const insideWalls = context.wallSolids.filter((solid) => enclosesStrictly(origin, solid));
  const wallSegments = insideWalls.length
    ? context.wallSolids.filter((solid) => !insideWalls.includes(solid)).flatMap(solidSegments)
    : context.walls;

  const segments = [...wallSegments, ...occluders.flatMap(rectSegments), ...context.bounds];
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
  return dropCollinear(polygon);
}
