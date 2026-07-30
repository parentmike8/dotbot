import { edgeNormal, polygonContains } from "@dotbot/game/geometry";
import type { Rect, Vec2 } from "@dotbot/game/types";

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
export type ViewPull = Vec2 & {
  /**
   * How much of the authored apparent height the view is allowed to expose.
   *
   * One is the resting drawing. Values above one are camera parallax, capped again by
   * `cappedLift` so a top face can never be consumed. Keeping magnitude separate from
   * direction avoids the old double-scaling trap where a half-length vector was applied
   * once in `awayness` and again while moving the vertex.
   */
  scale: number;
};

export const NORTH: ViewPull = { x: 0, y: -1, scale: 1 };

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * How far from the camera an object has to be before its top slides all the way round.
 *
 * Roughly a screen's half-diagonal at play zoom, so the effect reaches full strength at
 * the edge of view and is gentle in the middle where the player is looking.
 */
export const PARALLAX_HORIZON = 620;

/**
 * Which way an object's top slides, given where the camera is.
 *
 * Direction and magnitude are separate.
 *
 * The earlier pass returned a unit vector at every non-zero strength. Distance changed
 * only its angle, while every top still travelled its small authored lift. At play zoom,
 * 0.5, 1 and every value above 1 therefore looked effectively the same. `scale` carries
 * the missing magnitude now: one is the resting drawing, and distance plus strength add
 * bounded apparent travel on top. `topRect` and `topFace` still apply `cappedLift`, so a
 * solid never loses the lit top that tells the player where its cover footprint is.
 *
 * Do not encode magnitude in the vector length. That double-scales polygons because
 * `awayness` sees the shortened vector and the vertex displacement multiplies by it
 * again. A named scalar keeps half strength half strength.
 *
 * The interpolation is on the ANGLE, not the vector. Blending `NORTH` toward the away
 * direction componentwise gives exactly zero when an object is due south at half
 * strength — a real position, not a corner case — and a zero pull has no direction to
 * normalise. Rotating along the shortest arc is always unit length and never degenerate.
 *
 * `strength` is the debug/production tunable: 0 is today's fixed north exactly, 1
 * rotates fully away at the horizon, and values above 1 keep direction stable while
 * increasing the bounded travel. `magnitudeGain` lets solid cover stay conservative
 * while tall landmarks and elevated parts lean further.
 */
export function pullToward(
  centre: Vec2,
  viewCentre: Vec2,
  strength: number,
  magnitudeGain = 0.55,
): ViewPull {
  const dx = centre.x - viewCentre.x;
  const dy = centre.y - viewCentre.y;
  const distance = Math.hypot(dx, dy);
  if (distance < EPSILON || strength <= 0) return NORTH;

  const northAngle = Math.atan2(NORTH.y, NORTH.x);
  const awayAngle = Math.atan2(dy, dx);
  // Shortest arc, so the rotation never takes the long way round the circle.
  let delta = awayAngle - northAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  const distanceShare = Math.min(1, distance / PARALLAX_HORIZON);
  const reach = distanceShare * Math.min(1, strength);
  const angle = northAngle + delta * reach;
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
    scale: 1 + distanceShare * Math.max(0, strength) * Math.max(0, magnitudeGain),
  };
}

/** Unit direction from any public pull, preserving the useful zero-vector flat case. */
export function pullDirection(pull: Vec2): Vec2 {
  const length = Math.hypot(pull.x, pull.y);
  if (length < EPSILON) return { x: 0, y: 0 };
  return { x: pull.x / length, y: pull.y / length };
}

/** Resting callers pass a plain Vec2; only a camera pull carries extra travel. */
export function pullScale(pull: Vec2): number {
  const asked = (pull as Partial<ViewPull>).scale;
  return Number.isFinite(asked) ? Math.max(0, asked as number) : 1;
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
/**
 * The extent of a rectangle along a direction, which is what its cap measures against.
 *
 * `r.h` for a north pull and `r.w` for an east one, blended between. `volume` used `r.h`
 * outright, which was correct only because the pull could not turn: pulled east, a
 * 100-by-12 slab has 100 units to eat and was being capped against 12.
 */
function rectDepth(r: Rect, pull: Vec2): number {
  return Math.abs(pull.x) * r.w + Math.abs(pull.y) * r.h;
}

/**
 * The top face of an extruded RECTANGLE, and still a rectangle.
 *
 * This is the fast path `volume` draws, and the reason it can take a pull at all. Today's
 * top face is "the rect minus a south band of depth `lift`" — which is exactly the rect
 * intersected with itself shifted north by `lift`. Written that way the rule generalises
 * for free: shift along `pull` instead of north, and intersect. Two axis-aligned
 * rectangles intersect in a rectangle, so `volume` keeps returning a `Rect` and the three
 * dozen call sites that place detail on it are untouched.
 *
 * `topFace` moves each vertex along the pull instead, which is the right rule for an
 * arbitrary outline and the wrong one here: on an oblique pull it turns a rectangle into
 * a general quad, and there is nowhere to put the detail a fixture draws on its lid.
 *
 * The intersection is inside the footprint by construction, so the silhouette contract
 * holds without needing to be checked at every angle — unlike the polygon path, where it
 * had to be.
 */
export function topRect(r: Rect, lift: number, pull: Vec2 = NORTH): Rect {
  const direction = pullDirection(pull);
  const shift = cappedLift(rectDepth(r, direction), lift * pullScale(pull));
  const dx = direction.x * shift;
  const dy = direction.y * shift;
  const x = Math.max(r.x, r.x + dx);
  const y = Math.max(r.y, r.y + dy);
  return {
    x,
    y,
    w: Math.max(1, r.w - Math.abs(dx)),
    h: Math.max(1, r.h - Math.abs(dy)),
  };
}

export function topFace(points: Vec2[], lift: number, pull: Vec2 = NORTH): Vec2[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const direction = pullDirection(pull);
  const count = points.length;
  const normals = points.map((_, index) => edgeNormal(points, index));
  return points.map((point, index) => {
    const share = awayness(normals[(index - 1 + count) % count], normals[index], direction);
    if (share <= 0) return { ...point };
    const depth = depthAlong(points, point, direction);
    const distance = cappedLift(depth, lift * pullScale(pull)) * share;
    return { x: point.x + direction.x * distance, y: point.y + direction.y * distance };
  });
}
