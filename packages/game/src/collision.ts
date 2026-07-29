import { pointToSolidDistanceSquared, rectSolid, separateCircleFromSolid } from "./geometry";
import {
  isSolidObject,
  objectCollisionRects,
  physicsFloorId,
  ROUND_KINDS,
  stadiumAxis,
  STADIUM_KINDS,
  stairGuardRects,
  treeTrunkRadius,
} from "./mapModel";
import type { MapDocument, MapObject, Rect, Solid, Vec2 } from "./types";

/**
 * An object's TRUE collision shape, which for a round kind is an actual disc — a
 * capsule collapsed to a point, which the kernel already understands everywhere
 * and even has a name for (`isDisc`). Nothing approximated, nothing protruding.
 *
 * The first attempt stepped the disc into eight rects, on the theory that rects
 * were the only shape every consumer could read. Both halves of that were wrong:
 * capsules were already supported throughout the kernel, and the stepping took each
 * band's WIDEST point so the stack would contain the circle — which means it
 * circumscribed it, standing a slab of invisible collider off the top and bottom of
 * every drawn disc. Reported at once, and fairly: "there's still a square
 * protruding from the merry go round."
 *
 * The lesson is not about the arithmetic. A collider LARGER than its mark is a
 * worse failure than one that is smaller, because the player can neither see it nor
 * learn it — and offered a choice between approximating outward and approximating
 * inward, the right answer was to stop approximating.
 */
export function objectSolids(object: MapObject): Solid[] {
  if (!isSolidObject(object)) return [];
  if (!object.collisionParts?.length) {
    const inscribed = inscribedSolid(object);
    if (inscribed) return [inscribed];
  }
  return objectCollisionRects(object).map((rect) => rectSolid(rect));
}

/**
 * The collider for a kind whose glyph does not fill its own bounding box, or null
 * when the box is the honest answer.
 *
 * "Only the proper objects should be impassable, and their impassable barriers
 * should match their own edges." That is the whole rule, and two families of glyph
 * break it in the same direction — by drawing something inscribed in the box and
 * leaving the corners solid and invisible:
 *
 *   - ROUND_KINDS draw a disc, so they get a disc.
 *   - STADIUM_KINDS draw round ends with straight sides between them, so they get
 *     the stadium inscribed in the box. A rough blob is far better approximated by a
 *     stadium than by a rectangle, and the stadium is never wider than the mass.
 *
 * There used to be a third: `ferrisWheel`, which drew a rim 0.22 of its short side
 * — 29 units of a 132-wide object — and collided across the whole 132. It got a
 * capsule at half the short side, and then the kind was cut entirely, because a
 * glyph that needs a special case to stop being a wall is a glyph that is mostly
 * not there. What had made it read as solid ground in the first place was its cast
 * shadow, drawn from the full box at tower height, which is not the object.
 *
 * Where a shape cannot be matched exactly the error goes INWARD, every time. A
 * collider inside its mark costs a few units of overlap nobody notices; a collider
 * outside its mark is a wall the player can neither see nor learn.
 */
function inscribedSolid(object: MapObject): Solid | null {
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;

  if (ROUND_KINDS.has(object.kind)) {
    const r = Math.min(object.w, object.h) / 2;
    return { kind: "capsule", ax: cx, ay: cy, bx: cx, by: cy, r };
  }

  /**
   * A tree stops you at its trunk. See `treeTrunkRadius` for why, and for why a thicket
   * does not get this treatment.
   */
  if (object.kind === "tree") {
    const r = treeTrunkRadius(object);
    // The trunk is drawn a touch below centre, so the collider sits where the mark is.
    const trunkY = cy + (Math.min(object.w, object.h) / 2) * 0.06;
    return { kind: "capsule", ax: cx, ay: trunkY, bx: cx, by: trunkY, r };
  }

  if (STADIUM_KINDS.has(object.kind)) {
    return { kind: "capsule", ...stadiumAxis(object) };
  }

  return null;
}

/**
 * Static geometry on one physics plane. GROUND plans share the outdoor plane.
 *
 * Returns `Solid`s rather than rectangles: authored rect walls become rect solids
 * — the fast path, and bit-identical to what shipped — while compiled barriers
 * contribute capsules and convex hulls for walls that turn or curve.
 */
export function collectSolids(map: MapDocument, floorId: string): Solid[] {
  const targetFloorId = physicsFloorId(map, floorId);
  const solids: Solid[] = [];
  const addRects = (rects: Rect[]): void => {
    for (const rect of rects) solids.push(rectSolid(rect));
  };

  if (targetFloorId === physicsFloorId(map, "outdoor")) {
    addRects(map.outdoor.walls);
    for (const object of map.outdoor.objects) solids.push(...objectSolids(object));
    for (const barrier of map.outdoor.barriers ?? []) solids.push(...barrier.solids);
  }

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      if (physicsFloorId(map, floor.id) !== targetFloorId) continue;
      addRects(floor.walls);
      for (const object of floor.objects) solids.push(...objectSolids(object));
      addRects(floor.stairs.flatMap(stairGuardRects));
      for (const barrier of floor.barriers ?? []) solids.push(...barrier.solids);
    }
  }

  return solids;
}

/**
 * Rect-only view, for callers that still reason in rectangles.
 *
 * Non-rectangular barriers are invisible here, so anything that has to be correct
 * about the whole world uses `collectSolids` instead.
 */
export function collectSolidRects(map: MapDocument, floorId: string): Rect[] {
  return collectSolids(map, floorId)
    .filter((solid): solid is Extract<Solid, { kind: "rect" }> => solid.kind === "rect")
    .map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/**
 * Push a circle clear of an axis-aligned wall.
 *
 * Delegates to the kernel, which is pinned to a frozen copy of this arithmetic by
 * an exact-equality test. Every bot's movement — on the server and in client
 * prediction — resolves through here, so the two must never diverge by a bit.
 */
export function separateCircleFromRect(position: Vec2, radius: number, wall: Rect): Vec2 {
  return separateCircleFromSolid(position, radius, rectSolid(wall));
}

/** True when a circle overlaps a solid's area. */
export function circleIntersectsSolid(position: Vec2, radius: number, solid: Solid): boolean {
  return pointToSolidDistanceSquared(position, solid) < radius * radius;
}
