import type { Doorway, Rect } from "@dotbot/game/types";

export type DoorwayStyle = "open" | "sliding";

/** Exterior entrances stay visually open. Interior doors use a pocket-slider
 * language unless the map explicitly authors an open archway. */
export function doorwayStyle(doorway: Doorway, footprint: Rect): DoorwayStyle {
  if (doorway.open || doorwayOnPerimeter(doorway, footprint)) {
    return "open";
  }

  return "sliding";
}

export function doorwayOnPerimeter(doorway: Doorway, footprint: Rect): boolean {
  const tolerance = 10;
  if (doorway.dir === "h") {
    return Math.abs(doorway.y - footprint.y) <= tolerance ||
      Math.abs(doorway.y - (footprint.y + footprint.h)) <= tolerance;
  }

  return Math.abs(doorway.x - footprint.x) <= tolerance ||
    Math.abs(doorway.x - (footprint.x + footprint.w)) <= tolerance;
}
