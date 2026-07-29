import type { Rect } from "@dotbot/game/types";
import { type PerimeterEntrance } from "@dotbot/game/entrances";

/**
 * Drawing helpers for building entrances.
 *
 * The entrance geometry itself moved to `@dotbot/game/entrances` when the simulation
 * started needing it — vision leaks through a doorway, which is a rule about the world
 * and not about the picture of it. Re-exported here so the two drawing modules that
 * already import from this path keep working, and so there is still one place a renderer
 * asks "where are the doors".
 */

export { entranceMouth, isAcross, perimeterEntrances } from "@dotbot/game/entrances";
export type { PerimeterEntrance, Side } from "@dotbot/game/entrances";

/** A band of the given depth reaching out from the entrance's own elevation. */
export function outwardBand(entrance: PerimeterEntrance, fp: Rect, depth: number, half: number): Rect {
  const { door, side } = entrance;
  switch (side) {
    case "N":
      return { x: door.x - half, y: fp.y - depth, w: half * 2, h: depth };
    case "S":
      return { x: door.x - half, y: fp.y + fp.h, w: half * 2, h: depth };
    case "W":
      return { x: fp.x - depth, y: door.y - half, w: depth, h: half * 2 };
    default:
      return { x: fp.x + fp.w, y: door.y - half, w: depth, h: half * 2 };
  }
}

/** A band of the given depth reaching *into* the building from its elevation. */
export function inwardBand(entrance: PerimeterEntrance, fp: Rect, depth: number, half: number): Rect {
  const { door, side } = entrance;
  switch (side) {
    case "N":
      return { x: door.x - half, y: fp.y, w: half * 2, h: depth };
    case "S":
      return { x: door.x - half, y: fp.y + fp.h - depth, w: half * 2, h: depth };
    case "W":
      return { x: fp.x, y: door.y - half, w: depth, h: half * 2 };
    default:
      return { x: fp.x + fp.w - depth, y: door.y - half, w: depth, h: half * 2 };
  }
}
