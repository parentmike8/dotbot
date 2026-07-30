import { defaultGameConfig } from "./config";
import { pointToSolidDistanceSquared } from "./geometry";
import type { Doorway, Solid, Vec2 } from "./types";

/**
 * Extra space on EACH side of a full-size DotBot in an ordinary doorway.
 *
 * Four units was enough for the continuous collision solver, but not for the
 * eight-unit navigation graph: whether a 56-wide opening worked depended on
 * where graph nodes happened to land. One graph cell on either side makes the
 * passage a stable route rather than an alignment accident.
 */
export const DOORWAY_STEERING_MARGIN = 8;

export function minimumNavigableDoorwayWidth(
  botRadius = defaultGameConfig.botRadius,
  steeringMargin = DOORWAY_STEERING_MARGIN,
): number {
  return (botRadius + steeringMargin) * 2;
}

/** Standard person opening for the production full-size DotBot. */
export const STANDARD_DOORWAY_CLEAR_WIDTH = minimumNavigableDoorwayWidth();

export type OpeningCutGeometry = {
  /** The visible and physically clear gap between the wall caps. */
  clearWidth: number;
  /** Radius of each capsule cap, also the pullback at either jamb. */
  jambInset: number;
  /** Distance required between the surviving wall spines. */
  spineGapWidth: number;
};

/**
 * Reconcile authored clear width with the actual capsule geometry.
 *
 * The opening is the distance between the OUTER EDGES of two capsule caps. The
 * surviving wall spines therefore have to end one cap radius farther back at
 * each jamb. This is explicit here so changing wall thickness cannot silently
 * pinch a door even when its authored width is unchanged.
 */
export function openingCutGeometry(
  authoredClearWidth: number,
  wallThickness: number,
  botRadius = defaultGameConfig.botRadius,
  steeringMargin = DOORWAY_STEERING_MARGIN,
): OpeningCutGeometry {
  const clearWidth = Math.max(
    authoredClearWidth,
    minimumNavigableDoorwayWidth(botRadius, steeringMargin),
  );
  const jambInset = wallThickness / 2;
  return {
    clearWidth,
    jambInset,
    spineGapWidth: clearWidth + jambInset * 2,
  };
}

/** Unit vector along the wall run containing the doorway. */
export function doorwayTangent(doorway: Doorway): Vec2 {
  if (doorway.span) {
    const dx = doorway.span.bx - doorway.span.ax;
    const dy = doorway.span.by - doorway.span.ay;
    const length = Math.hypot(dx, dy);
    if (length > 1e-7) return { x: dx / length, y: dy / length };
  }
  return doorway.dir === "h" ? { x: 1, y: 0 } : { x: 0, y: 1 };
}

/** Unit vector through the doorway, perpendicular to its wall. */
export function doorwayNormal(doorway: Doorway): Vec2 {
  const tangent = doorwayTangent(doorway);
  return { x: -tangent.y, y: tangent.x };
}

/**
 * Points on the doorway centreline with enough run-up for a full-size body.
 * Audits and navigation regressions use the same normal and steering margin.
 */
export function doorwayTraversalPoints(
  doorway: Doorway,
  botRadius = defaultGameConfig.botRadius,
  steeringMargin = DOORWAY_STEERING_MARGIN,
): [Vec2, Vec2] {
  const normal = doorwayNormal(doorway);
  const distance = (doorway.thickness ?? 0) / 2 + botRadius + steeringMargin;
  return [
    { x: doorway.x - normal.x * distance, y: doorway.y - normal.y * distance },
    { x: doorway.x + normal.x * distance, y: doorway.y + normal.y * distance },
  ];
}

/** Exact distance from the opening centre to the nearest solid. */
export function doorwayHalfClearance(doorway: Doorway, solids: readonly Solid[]): number {
  if (solids.length === 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(Math.min(
    ...solids.map((solid) => pointToSolidDistanceSquared(doorway, solid)),
  ));
}
