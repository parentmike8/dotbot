import { edgeNormal } from "@dotbot/game/geometry";
import type { Vec2 } from "@dotbot/game/types";

/**
 * Where an extruded solid's top face lands.
 *
 * This is the one piece of the drawing language that does not import pixi, and it
 * is deliberate. `tone.ts` needs a browser to load, so every rule stated there is
 * a rule no test can reach — and these are the two the whole language rests on:
 * the silhouette stays equal to the footprint, and the lit top face survives. They
 * are the ones that most need pinning, so they live here.
 */

const EPSILON = 1e-6;

/**
 * The lit top face never drops below this share of the depth it is drawn into.
 *
 * Apparent height is drawn *inside* the shape, so it is always eating the top
 * face. A 16-unit column at lift 11 keeps a 5-unit top and reads as a dark blob
 * rather than a column, which is what the cap exists to prevent.
 */
export const TOP_FACE_MIN = 0.55;

/**
 * Apparent height, capped against the depth it is drawn into.
 *
 * Depth, not the shorter side. The pull is northward, so north-south extent is the
 * only dimension a front face can eat: capping a 12-wide, 90-deep locker bank
 * against its width held it to a 5-unit front face when it had 40 to spare.
 */
export function cappedLift(depth: number, lift: number): number {
  return Math.min(lift, Math.max(0, depth) * (1 - TOP_FACE_MIN));
}

/**
 * How far north a vertex is pulled, as a share of the lift.
 *
 * A vertex belongs to two faces and moves with whichever of them points furthest
 * south — not with their average. Averaging looks reasonable and is wrong twice
 * over: it leaves a rectangle's south corners half the height `volume` draws the
 * same rectangle at, and it pinches every corner where a south face meets a side
 * one, because the side face drags the shared vertex back up.
 */
export function southness(incoming: Vec2, outgoing: Vec2): number {
  return Math.max(0, incoming.y, outgoing.y);
}

/**
 * How deep the shape is directly north of a point: the gap up to the boundary
 * above it.
 *
 * This is the generalisation of a rectangle's height, and it is what the cap has to
 * measure. A bounding box will not do — a 12-thick wall that turns a corner has a
 * 112-unit box and 12 units of depth in either arm. Nor will the polygon's total
 * area, which stays comfortable while one arm's top face collapses to a sliver:
 * the L above keeps 56% of its area with the short arm reduced to 2 units of top.
 */
function depthNorthOf(points: Vec2[], normals: Vec2[], from: Vec2): number {
  let depth = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    // Only a boundary that faces the light can be the far side of this shape.
    if (normals[index].y > -0.5) continue;
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (from.x < Math.min(a.x, b.x) - EPSILON || from.x > Math.max(a.x, b.x) + EPSILON) continue;
    const run = b.x - a.x;
    const y = Math.abs(run) < EPSILON ? Math.min(a.y, b.y) : a.y + ((b.y - a.y) * (from.x - a.x)) / run;
    if (y >= from.y - EPSILON) continue;
    depth = Math.min(depth, from.y - y);
  }
  return depth;
}

/**
 * The top face of an extruded footprint: the footprint with its south-facing
 * boundary pulled north, so the drawn shape and the collider stay one shape.
 *
 * Each vertex is capped against its own local depth rather than the shape's, which
 * is what lets one outline carry a 12-deep arm and a 100-deep one and give each the
 * front face it has room for.
 */
export function topFace(points: Vec2[], lift: number): Vec2[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const count = points.length;
  const normals = points.map((_, index) => edgeNormal(points, index));
  return points.map((point, index) => {
    const pull = southness(normals[(index - 1 + count) % count], normals[index]);
    if (pull <= 0) return { ...point };
    const depth = depthNorthOf(points, normals, point);
    return { x: point.x, y: point.y - cappedLift(depth, lift) * pull };
  });
}
