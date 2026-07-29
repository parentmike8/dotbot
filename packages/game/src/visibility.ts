import { buildingContaining, floorPlanById, isGroundFloor, physicsFloorId } from "./mapModel";
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
    // THE FLOOR's extent, not the building's. A floor below ground is not bound by the
    // mass above it: the temple's undercroft runs out from under the pyramid, and clipping
    // its sight lines to the pyramid put a wall across a tunnel where nothing stands.
    boundsRect = plan?.bounds ?? building?.footprint ?? { x: 0, y: 0, w: map.width, h: map.height };
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
 * How far away a building's doorways still matter to a viewer.
 *
 * A spatial filter, not a list: only buildings this close get opened up, so the occluder
 * set stays small at a hundred buildings. Generous because the cost of opening one is a
 * few extra segments, and the benefit is that a door you can see across the street reads
 * as a door rather than as a painted line.
 */
export const APERTURE_RANGE = 420;

/**
 * How far an outdoor viewer sees at all, in or out.
 *
 * The aperture does not need to reach the far wall of a lobby or the end of the street —
 * "it can have a max distance in that the fog uncovers and same way out". So the polygon is
 * bounded by a box this far around the viewer rather than by the whole sheet, which caps
 * both directions with one number and keeps the ray count down as a bonus.
 *
 * 1200, RAISED FROM 560 BECAUSE 560 WAS ALMOST EXACTLY THE SCREEN'S HALF-DIAGONAL.
 *
 * The camera picks `scale = clamp(shortSide / 620, 0.55, 1.0)`, so on any window taller than
 * 620 CSS pixels the scale pins at 1.0 and one world unit is one pixel. A viewport around
 * 950 x 650 therefore has a half-diagonal of 576 — sixteen units past this cap. The fog
 * boundary sat right on the edge of the screen, so a body a little to one side of centre
 * popped out of existence for a few units of camera movement and back in again. Reported
 * from play: "I can see the downed bots here, but then the second I move slightly further
 * away, they disappear... basically anything in the viewport should be visible."
 *
 * ONE NUMBER, ON PURPOSE, AND RAISING IT IS A COMBAT CHANGE. `seesOutdoors` caps sighting at
 * this same value so that what is drawn and what can be seen are the same set — otherwise a
 * bot is targetable from inside the fog. Splitting it into a wide "render reach" and a narrow
 * "sighting reach" was the first instinct and it is worse: it would let the player see bodies
 * and bots that the AI, still sighting at 560, cannot see back. Keeping one number keeps the
 * two symmetric, which is why this is a deliberate raise rather than a rendering tweak.
 *
 * 1200 covers the corners of a 1920 x 1080 viewport (half-diagonal 1101) with margin. Watch
 * frame time if it goes much higher: the polygon's ray count scales with the wall segments
 * inside the bounds box, and this change already grew that box's area by about four and a
 * half times.
 */
export const OUTDOOR_SIGHT = 1200;

/** Buildings whose walls should stand in for their footprint, for a viewer here. */
export function openBuildings(map: MapDocument, position: Vec2): string[] {
  const open: string[] = [];
  for (const building of map.buildings) {
    const fp = building.footprint;
    const dx = Math.max(fp.x - position.x, 0, position.x - (fp.x + fp.w));
    const dy = Math.max(fp.y - position.y, 0, position.y - (fp.y + fp.h));
    if (dx * dx + dy * dy <= APERTURE_RANGE * APERTURE_RANGE) open.push(building.id);
  }
  return open;
}

/**
 * The outdoor plane with some buildings OPENED UP — their footprints replaced by their
 * actual ground-floor walls.
 *
 * This is the whole doorway mechanic, and it replaces a disc that should never have been
 * one. The disc was wrong by construction: it ignored walls, so standing in a doorway lit
 * a full circle and revealed the rooms either side of the entrance hall straight through
 * their partitions. Reported exactly that way — "those are behind a wall so i shouldn't be
 * able to see to them" — along with the honest conclusion: it should be the path line of
 * sight would actually take.
 *
 * So there is no aperture rule any more. The reason vision stopped dead at an elevation
 * was never physics, it was that `outdoor:street` lists every building's FOOTPRINT as one
 * opaque rect. A footprint is a convenience — cheap, and right while nobody could see in.
 * Swap it for the ground floor's own walls, which `compileWall` already cuts genuine gaps
 * into at every opening, and an ordinary visibility polygon does the rest: it flows through
 * the gap, spreads inside the entrance, and is stopped by the first interior partition.
 * Nothing special-cased, nothing to tune, and it is continuous because a polygon is.
 *
 * It also works identically in both directions, which the disc only faked. Standing inside,
 * the bounds are the whole map instead of your own footprint, so the same polygon reaches
 * out through the door and down the street.
 */
export function apertureContext(
  map: MapDocument,
  open: readonly string[],
  around?: Vec2,
): VisionContext {
  /**
   * Quantised into `OUTDOOR_SIGHT / 4` cells so a walking viewer reuses one cached context
   * for a while instead of building a fresh segment list every frame. The cost of a coarse
   * cell is a slightly larger bounding box than strictly needed, which only ever means the
   * polygon reaches a little further than the cap — never less.
   */
  const cell = OUTDOOR_SIGHT / 4;
  const anchor = around
    ? `@${Math.round(around.x / cell)},${Math.round(around.y / cell)}`
    : "";
  const key = `aperture:${[...open].sort().join(",")}${anchor}`;
  let byContext = contextCache.get(map);
  if (!byContext) {
    byContext = new Map();
    contextCache.set(map, byContext);
  }
  const cached = byContext.get(key);
  if (cached) return cached;

  const opened = new Set(open);
  const wallRects: Rect[] = [...map.outdoor.walls];
  const barriers: Barrier[] = [...(map.outdoor.barriers ?? [])];
  for (const building of map.buildings) {
    if (!opened.has(building.id)) {
      wallRects.push(building.footprint);
      continue;
    }
    const ground = building.floors.find(isGroundFloor);
    wallRects.push(...(ground?.walls ?? []));
    barriers.push(...(ground?.barriers ?? []));
  }

  const wallSolids: Solid[] = [
    ...wallRects.map(rectSolid),
    ...barriers.flatMap((barrier) => barrier.solids),
  ];
  const sheet: Rect = { x: 0, y: 0, w: map.width, h: map.height };
  let boundsRect = sheet;
  if (around) {
    const cx = Math.round(around.x / cell) * cell;
    const cy = Math.round(around.y / cell) * cell;
    const x = Math.max(sheet.x, cx - OUTDOOR_SIGHT);
    const y = Math.max(sheet.y, cy - OUTDOOR_SIGHT);
    boundsRect = {
      x,
      y,
      w: Math.min(sheet.x + sheet.w, cx + OUTDOOR_SIGHT) - x,
      h: Math.min(sheet.y + sheet.h, cy + OUTDOOR_SIGHT) - y,
    };
  }
  const result: VisionContext = {
    walls: wallSolids.flatMap(solidSegments),
    wallSolids,
    bounds: rectSegments(boundsRect),
    boundsRect,
  };
  byContext.set(key, result);
  return result;
}

/**
 * The vision context for a viewer standing on the outdoor plane, doors included.
 *
 * `contextKey` still splits street from each building ground floor, and still should —
 * it decides which arena you are in for everything else. It is just no longer what decides
 * what you can SEE, because a door joins the two and the split does not know that.
 */
export function outdoorVision(map: MapDocument, position: Vec2, alsoOpen: readonly string[] = []): VisionContext {
  return apertureContext(map, [...new Set([...openBuildings(map, position), ...alsoOpen])], position);
}

/**
 * Whether two positions on the outdoor plane can see each other, doors included.
 *
 * There is no doorway RULE any more, which is the point. This is `hasLineOfSight` against
 * a context where the buildings involved have their footprints replaced by their real
 * walls, so a door is just a gap and the ray either gets through it or does not.
 *
 * What that replaced, and why: the first version granted sight by proximity to a mouth,
 * with no wall test, on the argument that the two sides share no occluder list so a ray
 * could not be cast. That argument was wrong — the lists can be MERGED, which is all
 * `apertureContext` does — and the consequence of skipping the walls was exactly what play
 * reported. A disc lit a full circle through the doorway, revealing the rooms either side
 * of the entrance hall through their own partitions, and the fog stepped on and off at the
 * radius. Neither is a tuning problem; both come from granting sight without asking the
 * geometry.
 *
 * Still bounded, but by architecture rather than by a constant: you see down the line the
 * door actually points, as far as the first wall in the way. Symmetric for free, because
 * a segment crossing no wall crosses no wall in either direction.
 *
 * Both buildings are opened, not just the viewer's. A target inside a building the viewer
 * is far from would otherwise be hidden behind its own footprint, which is the failure the
 * merge exists to remove.
 */
export function seesOutdoors(
  map: MapDocument,
  aFloorId: string,
  a: Vec2,
  bFloorId: string,
  b: Vec2,
  dynamicOccluders: readonly Rect[] = [],
): boolean {
  // Only the outdoor plane has contexts joined by a hole in a wall. Two floors are
  // separated by a slab, and a stairwell is not a window.
  if (physicsFloorId(map, aFloorId) !== OUTDOOR_FLOOR_ID) return false;
  if (physicsFloorId(map, bFloorId) !== OUTDOOR_FLOOR_ID) return false;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = Math.hypot(dx, dy);
  if (span < 1e-6) return true;
  // The same cap the renderer's polygon is bounded by, so what is drawn and what is
  // targetable are the same set. Without it a bot could be shot from beyond the fog.
  if (span > OUTDOOR_SIGHT) return false;

  const open = new Set(openBuildings(map, a));
  const inB = buildingContaining(map, b);
  if (inB) open.add(inB.id);
  const context = apertureContext(map, [...open], a);

  for (const wall of [...context.walls, ...dynamicOccluders.flatMap(rectSegments)]) {
    const t = raySegment(a.x, a.y, dx, dy, wall);
    if (t !== null && t > 1e-6 && t < 1 - 1e-6) return false;
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
