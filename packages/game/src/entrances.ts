import { isGroundFloor, isVehicleDoor } from "./mapModel";
import type { Building, Doorway, MapDocument, Vec2 } from "./types";

/**
 * Where a building can be entered from the street.
 *
 * This lived in the renderer, which was fine while only drawing needed it: an apron on
 * the ground outside and a recess cut through the roof above, which have to agree or the
 * player is told the door is in two places. The simulation needs it now — vision leaks
 * through a doorway, and that is a rule about the world rather than about the picture of
 * it — so it moves down here and the renderer imports it back.
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
    const vehicle = isVehicleDoor(door);
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

/**
 * The mouth of an entrance: the middle of the gap itself.
 *
 * `door.x`/`door.y` is documented as the centre of the gap, and for a perimeter door that
 * point sits in the elevation — so it is the one place equidistant from inside and out,
 * which is exactly what a rule measuring "near this doorway, from either side" wants.
 */
export function entranceMouth(entrance: PerimeterEntrance): Vec2 {
  return { x: entrance.door.x, y: entrance.door.y };
}

const mouthCache = new WeakMap<MapDocument, Map<string, Vec2[]>>();

/**
 * Every way into a building, as points, cached per map.
 *
 * Cached because this is asked on the hot path — once per bot pair per tick in the worst
 * case — and the answer is a function of authored geometry that cannot change during a
 * run. Same `WeakMap` shape as `visionContext` for the same reason.
 */
export function buildingMouths(map: MapDocument, buildingId: string): Vec2[] {
  let byBuilding = mouthCache.get(map);
  if (!byBuilding) {
    byBuilding = new Map();
    mouthCache.set(map, byBuilding);
  }
  const cached = byBuilding.get(buildingId);
  if (cached) return cached;

  const building = map.buildings.find((item) => item.id === buildingId);
  const mouths = building ? perimeterEntrances(building).map(entranceMouth) : [];
  byBuilding.set(buildingId, mouths);
  return mouths;
}
