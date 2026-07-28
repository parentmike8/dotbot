import { edgeNormal, polygonContains } from "@dotbot/game/geometry";
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
 * Where the top face is pulled when nothing says otherwise: north, toward the light.
 *
 * This is a *view* direction, not a lighting one. A top-down camera sitting north of a
 * box sees the box's south face, so the top slides north — which is exactly what
 * buildings already do as the camera moves (`roofParallax`), and what every object on a
 * floor still does not. Objects have this pull nailed to north, which is what makes
 * their height read as a static south face rather than as height.
 */
export const NORTH: Vec2 = { x: 0, y: -1 };

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * How far a vertex is pulled, as a share of the lift.
 *
 * A vertex belongs to two faces and moves with whichever of them points furthest
 * AWAY from `pull` — not with their average. Averaging looks reasonable and is wrong
 * twice over: it leaves a rectangle's trailing corners half the height `volume` draws
 * the same rectangle at, and it pinches every corner where a trailing face meets a
 * side one, because the side face drags the shared vertex back up.
 */
export function awayness(incoming: Vec2, outgoing: Vec2, pull: Vec2 = NORTH): number {
  return Math.max(0, -dot(incoming, pull), -dot(outgoing, pull));
}

/**
 * How far a vertex is pulled north. The fixed-pull case, kept because it is the one
 * every caller still uses and it reads better than `awayness(a, b, NORTH)`.
 */
export function southness(incoming: Vec2, outgoing: Vec2): number {
  return awayness(incoming, outgoing, NORTH);
}

/**
 * How deep the shape is along `pull` from a point: the gap to the boundary that way.
 *
 * This is the generalisation of a rectangle's height, and it is what the cap has to
 * measure. A bounding box will not do — a 12-thick wall that turns a corner has a
 * 112-unit box and 12 units of depth in either arm. Nor will the polygon's total
 * area, which stays comfortable while one arm's top face collapses to a sliver:
 * the L above keeps 56% of its area with the short arm reduced to 2 units of top.
 *
 * A ray cast rather than the vertical scan this used to be, so the measurement turns
 * with the pull. For `pull = NORTH` the two are the same computation.
 *
 * It takes the FIRST boundary the ray crosses, whichever way that boundary faces. The
 * north-only version filtered to faces pointing north, which was a cheap way of saying
 * "the far side" and is only true on that one axis.
 *
 * And it measures nothing at all when the pull leaves the shape at `from`. Every vertex
 * sits ON the boundary, so a ray from one can set off straight out of the solid and cross
 * back in somewhere else entirely — an L's inner arm corner pulled east-south-east leaves
 * its own arm immediately and re-enters the *other* arm 95 units away, which read as 95
 * units of depth and pulled the corner a full unit outside the footprint.
 *
 * What separates the two is a containment test at the MIDDLE of the run, not at its start.
 * Sampling a hair along the pull from the vertex looks like the obvious test and fails on
 * every corner: a rectangle's south-west corner stepped north lands on the west edge, and
 * `polygonContains` is a strict interior test, so the whole north case collapsed to zero
 * lift. The midpoint needs the same care for the same reason — it is collinear with an
 * edge whenever the pull runs parallel to one — hence the nudge across the ray.
 */
function depthAlong(points: Vec2[], from: Vec2, pull: Vec2): number {
  let depth = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    /**
     * Solve `from + t * pull = a + s * (b - a)` for `t` along the ray and `s` along the
     * edge, by crossing both sides with the other direction:
     *
     *     t = (rel x edge) / (pull x edge)      s = (rel x pull) / (pull x edge)
     *
     * `cross` is zero when the ray runs parallel to the edge, which is the case the old
     * vertical scan handled by testing an x-range.
     */
    const edge = { x: b.x - a.x, y: b.y - a.y };
    const cross = pull.x * edge.y - pull.y * edge.x;
    if (Math.abs(cross) < EPSILON) continue;
    const rel = { x: a.x - from.x, y: a.y - from.y };
    const s = (rel.x * pull.y - rel.y * pull.x) / cross;
    if (s < -EPSILON || s > 1 + EPSILON) continue;
    const t = (rel.x * edge.y - rel.y * edge.x) / cross;
    if (t <= EPSILON) continue;
    depth = Math.min(depth, t);
  }
  /**
   * Nothing ahead means nowhere to go, so no crossing is zero depth rather than infinite.
   *
   * With the pull nailed north this could not arise: a vertex with no boundary north of it
   * is on the north edge, and a north-edge vertex has no pull to apply and returns before
   * asking. Off-axis it happens at once — a rectangle's north-east corner pulled
   * east-south-east has a small share of the lift and nothing ahead, because it sits on
   * the east face. Reading that as unbounded pulled the corner clean out of the footprint.
   */
  if (!Number.isFinite(depth)) return 0;
  /**
   * Both sides of the ray, because which one is the interior is exactly what is not
   * known here. Nudging one fixed way passed on a rectangle's west corner and failed on
   * its east one — the run is real if either side of its middle is inside the shape, and
   * a run that left the solid at the vertex has neither.
   */
  const middle = { x: from.x + pull.x * depth * 0.5, y: from.y + pull.y * depth * 0.5 };
  const across = { x: -pull.y * 1e-3, y: pull.x * 1e-3 };
  const inside = polygonContains(points, { x: middle.x + across.x, y: middle.y + across.y })
    || polygonContains(points, { x: middle.x - across.x, y: middle.y - across.y });
  return inside ? depth : 0;
}

/**
 * The top face of an extruded footprint: the footprint with its trailing boundary
 * pulled toward the viewer, so the drawn shape and the collider stay one shape.
 *
 * Each vertex is capped against its own local depth rather than the shape's, which
 * is what lets one outline carry a 12-deep arm and a 100-deep one and give each the
 * front face it has room for.
 *
 * `pull` is the direction the top slides, and it is the whole of what makes a solid's
 * height read as height rather than as a fixed south band. It must be a unit vector;
 * `NORTH` reproduces the fixed drawing exactly, which is the contract that lets this
 * generalise without changing a single pixel until a caller passes something else.
 */
export function topFace(points: Vec2[], lift: number, pull: Vec2 = NORTH): Vec2[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const count = points.length;
  const normals = points.map((_, index) => edgeNormal(points, index));
  return points.map((point, index) => {
    const share = awayness(normals[(index - 1 + count) % count], normals[index], pull);
    if (share <= 0) return { ...point };
    const depth = depthAlong(points, point, pull);
    const distance = cappedLift(depth, lift) * share;
    return { x: point.x + pull.x * distance, y: point.y + pull.y * distance };
  });
}
