import { clamp } from "./math";
import type { Rect, Segment, Solid, Vec2 } from "./types";

/**
 * The world's geometry kernel.
 *
 * DotBot was built on axis-aligned rectangles, which quietly decided what the
 * world could ever be: every building a pure rectangle, every wall north-south or
 * east-west, no curves, no ship, no cliff. The engine never required that —
 * collision is hand-rolled circle-vs-AABB, visibility already runs on arbitrary
 * segments, and navigation only ever asks two questions of an obstacle:
 *
 *   - how far is this point from you?
 *   - how far is this segment from you?
 *
 * So the whole runtime funnels through a handful of primitives. Generalise those
 * and the rectangle constraint dissolves without touching the systems above.
 *
 * Two concepts cover everything a world needs:
 *
 *  - A **Solid** is something a bot cannot enter: an axis-aligned rect (the fast
 *    path, and everything authored so far), a capsule (a wall at any angle, and
 *    the piece a curve is built from), or a convex polygon (a hull, a wedge).
 *    All three answer closest-point queries exactly, which is what separation,
 *    navigation clearance and spatial indexing need.
 *
 *  - A **Region** is an area: a building footprint, a floor plate, water, a park.
 *    Regions may be concave, because nothing is ever pushed out of one — walls do
 *    that. They only need containment, edges and a fill.
 *
 * Curves live in the *authoring* language and are tessellated into polylines
 * here. The runtime never sees an arc, so no system downstream has to understand
 * one, and authors still get to draw a curved wall or a round tower.
 */

export type { Segment, Solid } from "./types";

/** A closed outline. May be concave; nothing is ever pushed out of one. */
export type Region = { points: Vec2[] };

const EPSILON = 1e-9;

export function rectSolid(rect: Rect): Solid {
  return { kind: "rect", x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/**
 * Do two rectangles share any area? Touching edges do not count.
 *
 * Exported rather than re-written per caller: `cityQuality` had a private copy and the
 * renderer wanted a third, which is how three subtly different answers to "do these
 * overlap" end up in one codebase.
 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// ---------------------------------------------------------------------------
// Segment and point primitives
// ---------------------------------------------------------------------------

export function closestPointOnSegment(p: Vec2, ax: number, ay: number, bx: number, by: number): Vec2 {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return { x: ax, y: ay };
  const t = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / lengthSquared, 0, 1);
  return { x: ax + dx * t, y: ay + dy * t };
}

export function pointToSegmentDistanceSquared(p: Vec2, ax: number, ay: number, bx: number, by: number): number {
  const near = closestPointOnSegment(p, ax, ay, bx, by);
  const dx = p.x - near.x;
  const dy = p.y - near.y;
  return dx * dx + dy * dy;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

export function segmentsIntersect(a: Segment, b: Segment): boolean {
  const d1x = a.bx - a.ax;
  const d1y = a.by - a.ay;
  const d2x = b.bx - b.ax;
  const d2y = b.by - b.ay;
  const denominator = cross(d1x, d1y, d2x, d2y);
  if (Math.abs(denominator) < EPSILON) return false;
  const t = cross(b.ax - a.ax, b.ay - a.ay, d2x, d2y) / denominator;
  const u = cross(b.ax - a.ax, b.ay - a.ay, d1x, d1y) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function segmentToSegmentDistanceSquared(a: Segment, b: Segment): number {
  if (segmentsIntersect(a, b)) return 0;
  return Math.min(
    pointToSegmentDistanceSquared({ x: a.ax, y: a.ay }, b.ax, b.ay, b.bx, b.by),
    pointToSegmentDistanceSquared({ x: a.bx, y: a.by }, b.ax, b.ay, b.bx, b.by),
    pointToSegmentDistanceSquared({ x: b.ax, y: b.ay }, a.ax, a.ay, a.bx, a.by),
    pointToSegmentDistanceSquared({ x: b.bx, y: b.by }, a.ax, a.ay, a.bx, a.by),
  );
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

export function polygonSegments(points: Vec2[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return segments;
}

/** Even-odd ray crossing. Works for concave outlines. */
export function polygonContains(points: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(points: Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Signed area. Positive is clockwise on screen, because y grows downward. */
export function polygonArea(points: Vec2[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/**
 * Outward normal of edge `i`, given the polygon's winding. Renderers use this to
 * decide whether a face is lit or shaded, which is how the drawing language
 * generalises past axis-aligned boxes.
 */
export function edgeNormal(points: Vec2[], index: number): Vec2 {
  const a = points[index];
  const b = points[(index + 1) % points.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  // Clockwise on screen (positive signed area) puts the outward normal at
  // (dy, -dx); reversed winding flips it.
  const sign = polygonArea(points) > 0 ? 1 : -1;
  return { x: (dy / length) * sign, y: (-dx / length) * sign };
}

// ---------------------------------------------------------------------------
// Solid queries — the four functions every world system actually needs
// ---------------------------------------------------------------------------

export function solidBounds(solid: Solid): Rect {
  if (solid.kind === "rect") return { x: solid.x, y: solid.y, w: solid.w, h: solid.h };
  if (solid.kind === "capsule") {
    const minX = Math.min(solid.ax, solid.bx) - solid.r;
    const minY = Math.min(solid.ay, solid.by) - solid.r;
    return {
      x: minX,
      y: minY,
      w: Math.max(solid.ax, solid.bx) + solid.r - minX,
      h: Math.max(solid.ay, solid.by) + solid.r - minY,
    };
  }
  return polygonBounds(solid.points);
}

/** Squared distance from a point to the solid's area. Zero when inside. */
export function pointToSolidDistanceSquared(point: Vec2, solid: Solid): number {
  if (solid.kind === "rect") {
    const dx = point.x - clamp(point.x, solid.x, solid.x + solid.w);
    const dy = point.y - clamp(point.y, solid.y, solid.y + solid.h);
    return dx * dx + dy * dy;
  }
  if (solid.kind === "capsule") {
    const distance = Math.sqrt(pointToSegmentDistanceSquared(point, solid.ax, solid.ay, solid.bx, solid.by)) - solid.r;
    return distance <= 0 ? 0 : distance * distance;
  }
  if (polygonContains(solid.points, point)) return 0;
  let best = Infinity;
  for (const edge of polygonSegments(solid.points)) {
    best = Math.min(best, pointToSegmentDistanceSquared(point, edge.ax, edge.ay, edge.bx, edge.by));
  }
  return best;
}

/** Squared distance from a segment to the solid's area. Zero when they touch. */
export function segmentToSolidDistanceSquared(start: Vec2, end: Vec2, solid: Solid): number {
  const ray: Segment = { ax: start.x, ay: start.y, bx: end.x, by: end.y };
  if (solid.kind === "capsule") {
    const spine: Segment = { ax: solid.ax, ay: solid.ay, bx: solid.bx, by: solid.by };
    const distance = Math.sqrt(segmentToSegmentDistanceSquared(ray, spine)) - solid.r;
    return distance <= 0 ? 0 : distance * distance;
  }

  const outline = solidSegments(solid);
  if (pointToSolidDistanceSquared(start, solid) === 0 || pointToSolidDistanceSquared(end, solid) === 0) return 0;
  let best = Infinity;
  for (const edge of outline) {
    const distance = segmentToSegmentDistanceSquared(ray, edge);
    if (distance === 0) return 0;
    best = Math.min(best, distance);
  }
  return best;
}

/**
 * The occluding outline used for line of sight.
 *
 * A capsule is approximated by the quad along its spine: caps contribute almost
 * nothing to what a wall hides, and four segments keep the visibility pass as
 * cheap as it is for a rectangle.
 */
export function solidSegments(solid: Solid): Segment[] {
  if (solid.kind === "rect") {
    const { x, y, w, h } = solid;
    return polygonSegments([
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
    ]);
  }
  if (solid.kind === "capsule") {
    const dx = solid.bx - solid.ax;
    const dy = solid.by - solid.ay;
    const length = Math.hypot(dx, dy);
    if (length < EPSILON) {
      // A disc occludes as the square it inscribes.
      const { ax, ay, r } = solid;
      return polygonSegments([
        { x: ax - r, y: ay - r }, { x: ax + r, y: ay - r },
        { x: ax + r, y: ay + r }, { x: ax - r, y: ay + r },
      ]);
    }
    const nx = (-dy / length) * solid.r;
    const ny = (dx / length) * solid.r;
    return polygonSegments([
      { x: solid.ax + nx, y: solid.ay + ny },
      { x: solid.bx + nx, y: solid.by + ny },
      { x: solid.bx - nx, y: solid.by - ny },
      { x: solid.ax - nx, y: solid.ay - ny },
    ]);
  }
  return polygonSegments(solid.points);
}

/** Push a circle clear of a solid along the shortest exit. */
export function separateCircleFromSolid(position: Vec2, radius: number, solid: Solid): Vec2 {
  if (solid.kind === "capsule") {
    const near = closestPointOnSegment(position, solid.ax, solid.ay, solid.bx, solid.by);
    return pushOut(position, near, radius + solid.r, (clearance) => spineFallback(solid, position, clearance));
  }

  if (solid.kind === "rect") {
    const near = {
      x: clamp(position.x, solid.x, solid.x + solid.w),
      y: clamp(position.y, solid.y, solid.y + solid.h),
    };
    return pushOut(position, near, radius, () => rectFallback(position, radius, solid));
  }

  // Convex polygon: nearest boundary point, and which edge owns it.
  let near = position;
  let nearestEdge = 0;
  let best = Infinity;
  const edges = polygonSegments(solid.points);
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const candidate = closestPointOnSegment(position, edge.ax, edge.ay, edge.bx, edge.by);
    const dx = position.x - candidate.x;
    const dy = position.y - candidate.y;
    const distance = dx * dx + dy * dy;
    if (distance < best) {
      best = distance;
      near = candidate;
      nearestEdge = index;
    }
  }
  if (!polygonContains(solid.points, position)) {
    return pushOut(position, near, radius, () => position);
  }
  /**
   * Inside: leave along the nearest edge's *outward normal*.
   *
   * Pushing away from the boundary point — the obvious move, and the one this
   * first did — drives a trapped bot deeper into the shape, because from inside
   * the vector from the wall to the bot points inward.
   */
  const normal = edgeNormal(solid.points, nearestEdge);
  return { x: near.x + normal.x * radius, y: near.y + normal.y * radius };
}

/**
 * `fallback` receives the full clearance, not just the solid's own size. Handing
 * it the wall radius alone leaves a bot resting exactly on the surface rather
 * than clear of it, which is a stuck bot one frame later.
 */
function pushOut(position: Vec2, near: Vec2, clearance: number, fallback: (clearance: number) => Vec2): Vec2 {
  const dx = position.x - near.x;
  const dy = position.y - near.y;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= clearance * clearance) return position;
  if (distanceSquared > 0.0001) {
    const distance = Math.sqrt(distanceSquared);
    const push = (clearance - distance) / distance;
    return { x: position.x + dx * push, y: position.y + dy * push };
  }
  return fallback(clearance);
}

/** Dead centre of a capsule spine: leave perpendicular to it. */
function spineFallback(solid: Extract<Solid, { kind: "capsule" }>, position: Vec2, clearance: number): Vec2 {
  const dx = solid.bx - solid.ax;
  const dy = solid.by - solid.ay;
  const length = Math.hypot(dx, dy);
  // A disc has no perpendicular. Any direction is as good as another, so pick a
  // fixed one rather than returning the position unchanged and staying stuck.
  if (length < EPSILON) return { x: position.x + clearance, y: position.y };
  return { x: position.x + (-dy / length) * clearance, y: position.y + (dx / length) * clearance };
}

/** Dead centre of a rect: leave through its nearest face. */
function rectFallback(position: Vec2, radius: number, solid: Extract<Solid, { kind: "rect" }>): Vec2 {
  const left = position.x - solid.x;
  const right = solid.x + solid.w - position.x;
  const top = position.y - solid.y;
  const bottom = solid.y + solid.h - position.y;
  const least = Math.min(left, right, top, bottom);
  if (least === left) return { x: solid.x - radius, y: position.y };
  if (least === right) return { x: solid.x + solid.w + radius, y: position.y };
  if (least === top) return { x: position.x, y: solid.y - radius };
  return { x: position.x, y: solid.y + solid.h + radius };
}

// ---------------------------------------------------------------------------
// Authoring: curves in, polylines out
// ---------------------------------------------------------------------------

/** Points along a circular arc, inclusive of both ends. */
export function arcPoints(
  center: Vec2,
  radius: number,
  fromRadians: number,
  toRadians: number,
  steps = Math.max(3, Math.ceil((Math.abs(toRadians - fromRadians) / (Math.PI / 2)) * 6)),
): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = fromRadians + ((toRadians - fromRadians) * i) / steps;
    points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  return points;
}

/** A closed circle as a polygon, for round towers and tanks. */
export function circlePoints(center: Vec2, radius: number, steps = 24): Vec2[] {
  return arcPoints(center, radius, 0, Math.PI * 2, steps).slice(0, -1);
}

/**
 * Round the corners of a polyline. This is how an author gets a curved wall
 * without describing one: give the corner a radius and the kernel produces the
 * tangent arc, so downstream systems still only ever see straight segments.
 */
export function filletCorners(points: Vec2[], radius: number, closed = false, steps = 5): Vec2[] {
  if (radius <= 0 || points.length < 3) return [...points];
  const out: Vec2[] = [];
  const last = points.length - 1;

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const isEnd = !closed && (i === 0 || i === last);
    if (isEnd) {
      out.push(current);
      continue;
    }
    const previous = points[(i - 1 + points.length) % points.length];
    const next = points[(i + 1) % points.length];

    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y) || 1;
    const outLength = Math.hypot(next.x - current.x, next.y - current.y) || 1;
    const cut = Math.min(radius, inLength / 2, outLength / 2);

    const start = {
      x: current.x + ((previous.x - current.x) / inLength) * cut,
      y: current.y + ((previous.y - current.y) / inLength) * cut,
    };
    const end = {
      x: current.x + ((next.x - current.x) / outLength) * cut,
      y: current.y + ((next.y - current.y) / outLength) * cut,
    };

    // Quadratic through the corner: cheap, always tangent, and good enough at
    // the sizes a floor plan works at.
    out.push(start);
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const inverse = 1 - t;
      out.push({
        x: inverse * inverse * start.x + 2 * inverse * t * current.x + t * t * end.x,
        y: inverse * inverse * start.y + 2 * inverse * t * current.y + t * t * end.y,
      });
    }
    out.push(end);
  }
  return out;
}

/** Unit left-hand normal of the direction from `from` to `to`. */
function leftNormal(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

/**
 * Move a polyline sideways by `distance`, keeping its corners sharp.
 *
 * Each vertex lands where its two offset edges intersect, which is the only
 * placement that puts *both* faces at the right depth. Offsetting along the
 * average of the two edge directions instead — the obvious shortcut — under-shoots
 * every corner: at a right angle it moves the vertex by `distance` when the miter
 * needs `distance * sqrt(2)`, so the outline visibly pinches where walls meet.
 *
 * Near a spike the two edges approach anti-parallel and the intersection runs away
 * to infinity, so the miter is clamped. A blunted spike is wrong by a few units; an
 * unclamped one puts geometry on the far side of the map.
 */
export function offsetPolyline(points: Vec2[], distance: number, closed = false, maxMiter = 4): Vec2[] {
  if (distance === 0 || points.length < 2) return points.map((point) => ({ ...point }));
  const last = points.length - 1;

  return points.map((point, index) => {
    const hasIncoming = closed || index > 0;
    const hasOutgoing = closed || index < last;
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const incoming = hasIncoming ? leftNormal(previous, point) : leftNormal(point, next);
    const outgoing = hasOutgoing ? leftNormal(point, next) : leftNormal(previous, point);

    const scale = 1 + incoming.x * outgoing.x + incoming.y * outgoing.y;
    const bx = incoming.x + outgoing.x;
    const by = incoming.y + outgoing.y;
    if (scale < 1 / maxMiter) {
      const length = Math.hypot(bx, by);
      if (length < EPSILON) return { x: point.x, y: point.y };
      return { x: point.x + (bx / length) * distance, y: point.y + (by / length) * distance };
    }
    return { x: point.x + (bx / scale) * distance, y: point.y + (by / scale) * distance };
  });
}

/**
 * Move every edge of a closed outline inward by `distance`, whichever way it is
 * wound. A negative distance grows it instead.
 *
 * This is what lets an author give a building its **outer** edge — the dimension
 * you would measure on site — and get the shell wall's centreline for free. Author
 * the centreline instead and the building is quietly `thickness/2` bigger than its
 * stated footprint, which is the kind of error nobody notices until a bot walks
 * through a wall drawn somewhere else.
 */
export function insetPolygon(points: Vec2[], distance: number, maxMiter = 4): Vec2[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  // Clockwise on screen puts the interior on each edge's left.
  const inward = polygonArea(points) > 0 ? 1 : -1;
  return offsetPolyline(points, distance * inward, true, maxMiter);
}

/**
 * A thick wall along a path, as capsules.
 *
 * Capsules are the right primitive for this: exact at any angle, self-joining at
 * corners with no mitre maths, and cheap to test. A curved wall is simply a path
 * with more points.
 */
export function thickenPath(points: Vec2[], thickness: number, closed = false): Solid[] {
  const radius = thickness / 2;
  const solids: Solid[] = [];
  /**
   * A single point is a wall stretch shorter than its own thickness — the pier
   * left between a door and the wall's end, say. Its spine has no length but its
   * material does, so it becomes a disc rather than disappearing.
   */
  if (points.length === 1) {
    return [{ kind: "capsule", ax: points[0].x, ay: points[0].y, bx: points[0].x, by: points[0].y, r: radius }];
  }
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < EPSILON) continue;
    solids.push({ kind: "capsule", ax: a.x, ay: a.y, bx: b.x, by: b.y, r: radius });
  }
  if (!solids.length && points.length) {
    return [{ kind: "capsule", ax: points[0].x, ay: points[0].y, bx: points[0].x, by: points[0].y, r: radius }];
  }
  return solids;
}

/** True when a capsule has collapsed to a disc: a pier, or a round column. */
export function isDisc(solid: Solid): boolean {
  return solid.kind === "capsule" && solid.ax === solid.bx && solid.ay === solid.by;
}

// ---------------------------------------------------------------------------
// Arc length — how openings are placed on a wall that is not axis-aligned
// ---------------------------------------------------------------------------

export function pathLength(points: Vec2[], closed = false): number {
  let total = 0;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** The point a given distance along a path, and the direction there. */
export function pointAtArcLength(points: Vec2[], distance: number, closed = false): { at: Vec2; dir: Vec2 } {
  const count = closed ? points.length : points.length - 1;
  let remaining = Math.max(0, distance);
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPSILON) continue;
    if (remaining <= length || i === count - 1) {
      const t = Math.min(1, remaining / length);
      return {
        at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        dir: { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
      };
    }
    remaining -= length;
  }
  const last = points.at(-1) ?? { x: 0, y: 0 };
  return { at: last, dir: { x: 1, y: 0 } };
}

/**
 * Distance along a path to the point nearest `target`.
 *
 * This is what lets an author place an opening by saying roughly *where* it is —
 * "a door near the loading yard" — instead of computing arc length by hand. The
 * compiler snaps the anchor onto the wall.
 */
export function arcLengthNearest(points: Vec2[], target: Vec2, closed = false): number {
  const count = closed ? points.length : points.length - 1;
  let travelled = 0;
  let bestDistance = Infinity;
  let bestArc = 0;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPSILON) continue;
    const near = closestPointOnSegment(target, a.x, a.y, b.x, b.y);
    const distance = Math.hypot(target.x - near.x, target.y - near.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestArc = travelled + Math.hypot(near.x - a.x, near.y - a.y);
    }
    travelled += length;
  }
  return bestArc;
}

/**
 * Cut a path into the stretches that survive a set of arc-length gaps. This is
 * how a doorway becomes an actual hole: the compiler simply never emits collision
 * for the removed stretch.
 */
export function splitPathByGaps(
  points: Vec2[],
  gaps: Array<{ from: number; to: number }>,
  closed = false,
  jambInset = 0,
): Vec2[][] {
  const total = pathLength(points, closed);
  const sorted = gaps
    .map((gap) => ({ from: Math.max(0, Math.min(gap.from, gap.to)), to: Math.min(total, Math.max(gap.from, gap.to)) }))
    .filter((gap) => gap.to > gap.from)
    .sort((a, b) => a.from - b.from);

  /**
   * `jambInset` pulls a surviving stretch back from the gap it abuts, and only
   * from that end. A thickened path's end cap reaches half a thickness past its
   * last point, so without it every opening is pinched by the full wall
   * thickness — a 56-unit door in a 12-unit wall leaves 44 of clear, and the bot
   * is 48 wide. The path's own ends are untouched: a wall that simply stops has a
   * rounded end, which is correct.
   */
  const keep: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  let cutBehind = false;
  for (const gap of sorted) {
    if (gap.from > cursor) keep.push({ from: cursor + (cutBehind ? jambInset : 0), to: gap.from - jambInset });
    cursor = Math.max(cursor, gap.to);
    cutBehind = true;
  }
  if (cursor < total) keep.push({ from: cursor + (cutBehind ? jambInset : 0), to: total });

  return keep.map((raw) => {
    // Inverted means the stretch is shorter than the wall is thick: a pier, which
    // still exists as a disc. Collapse it to its midpoint rather than dropping it.
    const span = raw.to >= raw.from
      ? raw
      : { from: (raw.from + raw.to) / 2, to: (raw.from + raw.to) / 2 };
    const run: Vec2[] = [pointAtArcLength(points, span.from, closed).at];
    // Carry every original vertex that falls inside the span, so corners survive.
    let travelled = 0;
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      travelled += length;
      if (travelled > span.from && travelled < span.to) run.push({ x: b.x, y: b.y });
    }
    run.push(pointAtArcLength(points, span.to, closed).at);
    return pathLength(run) > EPSILON ? run : [run[0]];
  });
}

/**
 * The drawable outline of a thick path: one closed polygon tracing up one side
 * and back down the other, mitered at every corner. Used for rendering; collision
 * keeps the capsules.
 */
export function pathOutline(points: Vec2[], thickness: number, closed = false): Vec2[] {
  const radius = thickness / 2;
  return [
    ...offsetPolyline(points, radius, closed),
    ...offsetPolyline(points, -radius, closed).reverse(),
  ];
}
