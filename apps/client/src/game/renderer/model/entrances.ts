import { isGroundFloor } from "@dotbot/game/mapModel";
import type { Building, Doorway, Rect } from "@dotbot/game/types";

/**
 * Where a building can be entered from the street.
 *
 * Two things need this and must agree: the apron on the ground outside, and the
 * recess cut through the roof above. If they disagree the player is told the door
 * is in two different places.
 */

export type Side = "N" | "S" | "W" | "E";

export type PerimeterEntrance = {
  door: Doorway;
  side: Side;
  /** A roll-up takes vehicles; anything else is a person door. */
  vehicle: boolean;
};

export function perimeterEntrances(building: Building): PerimeterEntrance[] {
  const ground = building.floors.find(isGroundFloor);
  if (!ground) return [];
  const fp = building.footprint;
  const tol = 12;
  const out: PerimeterEntrance[] = [];

  for (const door of ground.doorways) {
    // A door with no stated kind is read by width, the way the old rect maps
    // implied it: a wide opening standing permanently open is a vehicle door.
    const vehicle = door.opening ? door.opening === "rollup" : door.open === true && door.width >= 96;
    let side: Side | null = null;
    if (door.dir === "h" && Math.abs(door.y - fp.y) <= tol) side = "N";
    else if (door.dir === "h" && Math.abs(door.y - (fp.y + fp.h)) <= tol) side = "S";
    else if (door.dir === "v" && Math.abs(door.x - fp.x) <= tol) side = "W";
    else if (door.dir === "v" && Math.abs(door.x - (fp.x + fp.w)) <= tol) side = "E";
    if (side) out.push({ door, side, vehicle });
  }
  return out;
}

/** True when the entrance runs east-west, i.e. sits in the north or south wall. */
export function isAcross(side: Side): boolean {
  return side === "N" || side === "S";
}

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
