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

/** Visible passable strip replacing the interior side of an exterior door.
 * The facade can animate independently; an active interior floor always sees
 * this opening rather than a closed leaf or the dark interior-floor tile. */
export function perimeterDoorThresholdRect(doorway: Doorway, footprint: Rect, depth = 16): Rect | null {
  if (!doorwayOnPerimeter(doorway, footprint)) return null;

  if (doorway.dir === "h") {
    const north = Math.abs(doorway.y - footprint.y) <= 10;
    return {
      x: doorway.x - doorway.width / 2,
      y: north ? footprint.y : footprint.y + footprint.h - depth,
      w: doorway.width,
      h: depth,
    };
  }

  const west = Math.abs(doorway.x - footprint.x) <= 10;
  return {
    x: west ? footprint.x : footprint.x + footprint.w - depth,
    y: doorway.y - doorway.width / 2,
    w: depth,
    h: doorway.width,
  };
}
