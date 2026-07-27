import { pointToSolidDistanceSquared, rectSolid, separateCircleFromSolid } from "./geometry";
import { objectCollisionRects, physicsFloorId, stairGuardRects } from "./mapModel";
import type { MapDocument, Rect, Solid, Vec2 } from "./types";

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
    addRects(map.outdoor.objects.flatMap(objectCollisionRects));
    for (const barrier of map.outdoor.barriers ?? []) solids.push(...barrier.solids);
  }

  for (const building of map.buildings) {
    for (const floor of building.floors) {
      if (physicsFloorId(map, floor.id) !== targetFloorId) continue;
      addRects(floor.walls);
      addRects(floor.objects.flatMap(objectCollisionRects));
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
