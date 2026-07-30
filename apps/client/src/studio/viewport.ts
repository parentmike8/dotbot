import { arcLengthNearest, pointAtArcLength } from "@dotbot/game/geometry";
import { resolvePath, type SourceBuilding, type SourceWall } from "@dotbot/game/mapSource";
import type { Vec2 } from "@dotbot/game/types";

/**
 * Where a click lands, in world units — the seam between a mouse and an edit.
 *
 * Pulled out of `StudioCanvas` because that class constructs a pixi `Application`, so
 * every one of these was a private method no test could reach. They are the whole
 * pointer path: screen to world, world to grid, and which wall an opening belongs to.
 * The literal each edit emits was already covered by `mapSourcePatch.test.ts`, and the
 * compile step by the map's own audits — this was the gap between them, where a
 * transposed axis or an off-by-one snap would have produced a perfectly well-formed
 * edit in the wrong place.
 */

/** Just the parts of a DOMRect this needs, so a test does not need a DOM. */
export type ViewBox = { left: number; top: number; width: number; height: number };

/**
 * The canvas is centred on `centre` at `scale` pixels per world unit, so a click is
 * measured from the middle of the box rather than its corner.
 */
export function screenToWorld(
  clientX: number,
  clientY: number,
  box: ViewBox,
  centre: Vec2,
  scale: number,
): Vec2 {
  return {
    x: centre.x + (clientX - box.left - box.width / 2) / scale,
    y: centre.y + (clientY - box.top - box.height / 2) / scale,
  };
}

/** The exact inverse used to place fixed-size map markers over the shared art. */
export function worldToScreen(
  point: Vec2,
  box: ViewBox,
  centre: Vec2,
  scale: number,
): Vec2 {
  return {
    x: box.left + box.width / 2 + (point.x - centre.x) * scale,
    y: box.top + box.height / 2 + (point.y - centre.y) * scale,
  };
}

/** Nearest grid intersection; `grid` of 0 means the author turned snapping off. */
export function snapToGrid(point: Vec2, grid: number): Vec2 {
  if (!grid) return point;
  return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid };
}

/**
 * Beyond half a bot's width from any wall, the click was not meant for one.
 *
 * The same figure the rest of the map uses for "a bot could be standing here", which is
 * the right scale for "did the author mean this wall".
 */
export const WALL_PICK_RANGE = 24;

/**
 * The authored wall nearest a point, and the point snapped onto its centreline.
 *
 * This is what decides where an opening gets cut. It compares against the *resolved*
 * path, so a curved or diagonal wall is measured along its real centreline rather than
 * its endpoints, and it returns the arc-length projection so the door lands on the wall
 * rather than beside it.
 */
export function wallNear(
  source: SourceBuilding | null,
  floorLabel: string,
  point: Vec2,
  range = WALL_PICK_RANGE,
): { wall: SourceWall; at: Vec2 } | null {
  if (!source) return null;
  const floor = source.floors.find((candidate) => candidate.label === floorLabel);
  let best: { wall: SourceWall; at: Vec2; distance: number } | null = null;
  for (const wall of floor?.walls ?? []) {
    const path = resolvePath(wall.path, wall.closed);
    const arc = arcLengthNearest(path, point, wall.closed ?? false);
    const at = pointAtArcLength(path, arc, wall.closed ?? false).at;
    const distance = Math.hypot(at.x - point.x, at.y - point.y);
    if (!best || distance < best.distance) best = { wall, at, distance };
  }
  return best && best.distance < range ? { wall: best.wall, at: best.at } : null;
}
