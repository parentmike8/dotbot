import { buildingContaining, physicsFloorId } from "./mapModel";
import { distance } from "./math";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Building, MapDocument, MapObject, Vec2 } from "./types";

/**
 * What a sign says, and when you are close enough to read it.
 *
 * The lit-model language had no way to put text in the world. Building names exist,
 * but they are baked into the art as a single label per footprint — there is no
 * mechanism for the world to tell you anything else, which is why the map cannot
 * currently say "four floors" or "clinic" or anything a real street would.
 *
 * Two rules, and they are the whole design.
 *
 * A sign's text is DERIVED, never authored. Type a building's name onto a sign and
 * you have made a second copy of it that can disagree with the first — the same class
 * of bug as the drawn silhouette disagreeing with the collider, and this codebase has
 * spent a lot of this session on that. So a sign reads its own surroundings.
 *
 * And reading is PROXIMITY, not interaction. There is no key to press and nothing to
 * aim at; you walk near a sign and it becomes legible, the way signs work. That also
 * makes it the general mechanic the task asks for: anything that wants to say
 * something in the world can be a sign with a different reading.
 */

/** How close a bot's centre must be for a sign to be legible at all. */
export const SIGN_READ_RANGE = 150;
/**
 * Inside this the text is at full strength; between here and the range it fades.
 *
 * A ramp rather than a switch, because a label that pops on at a threshold reads as
 * UI and the contract's whole objection to UI is that it is not part of the world.
 */
export const SIGN_FULL_RANGE = 96;

export type SignReading = {
  /** The sign object itself, so the caller knows where to draw. */
  sign: MapObject;
  /** Two lines at most. A sign you have to stop and study is a menu. */
  title: string;
  detail: string;
  /** 0 at the edge of range, 1 within `SIGN_FULL_RANGE`. */
  strength: number;
  /**
   * Which way is open ground, as a unit vector — away from whatever the sign is
   * describing.
   *
   * The words have to go somewhere, and the first two attempts put them at a fixed
   * offset north of the plate, where what happened to be behind them decided whether
   * they could be read. Play reported it twice: first as light ink lost on a mid-grey
   * footway, then — after darkening — as dark ink lost on the clinic's own dark wall
   * band, with the line below it perfectly legible on lighter slab one row down.
   *
   * No ink solves that, because the ground changes. What solves it is not drawing over
   * the building: a sign stands on a footway facing away from the thing it names, so
   * the open side is the readable side, and the probe that found the building already
   * knows which way that is.
   */
  open: Vec2;
};

/**
 * What this sign has to say, from the map around it.
 *
 * A sign standing on or against a building names it and counts its floors. One
 * standing in the open names the block it is on. Both are read from the map, so a
 * building renamed or a floor added updates every sign that mentions it for free.
 */
export function signText(
  map: MapDocument,
  sign: MapObject,
): { title: string; detail: string; open: Vec2 } {
  const centre = { x: sign.x + sign.w / 2, y: sign.y + sign.h / 2 };
  /**
   * Probed at the sign's own centre first, then a little way in each direction.
   *
   * A sign is mounted ON a building's face, so its centre often sits just outside the
   * footprint it is describing — naming the street instead of the building it is
   * bolted to. The probe distance is a bot's width: far enough to cross a wall, near
   * enough that it cannot reach a different building.
   */
  const REACH = 48;
  /**
   * Each probe carries the direction it looked in, so finding the building also finds
   * which way is NOT the building. The centre probe has no direction — a sign standing
   * inside a footprint has no open side to prefer — and falls back to north.
   */
  const probes: Array<{ at: Vec2; toward: Vec2 }> = [
    { at: centre, toward: { x: 0, y: -1 } },
    { at: { x: centre.x + REACH, y: centre.y }, toward: { x: 1, y: 0 } },
    { at: { x: centre.x - REACH, y: centre.y }, toward: { x: -1, y: 0 } },
    { at: { x: centre.x, y: centre.y + REACH }, toward: { x: 0, y: 1 } },
    { at: { x: centre.x, y: centre.y - REACH }, toward: { x: 0, y: -1 } },
  ];
  const describe = (building: Building, toward: Vec2) => {
    // ROOF is the exterior, not a storey you can stand on, so it is not counted.
    const storeys = building.floors.filter((floor) => floor.label !== "ROOF").length;
    return {
      title: building.name,
      detail: `${storeys} ${storeys === 1 ? "FLOOR" : "FLOORS"}`,
      // Away from the building, which is the footway the sign faces.
      open: { x: -toward.x, y: -toward.y },
    };
  };
  for (const probe of probes) {
    const building = buildingContaining(map, probe.at);
    if (building) return describe(building, probe.toward);
  }

  /**
   * Still nothing, so fall back to the NEAREST footprint rather than to a place
   * name — and only if it is close enough to be the thing this sign is for.
   *
   * The cardinal probes reach 48 units, which is a bot's width, and that is fine
   * for a sign bolted to a flat wall. It is not enough for a sign on the queueing
   * ground outside a faceted building: the pavilion's sign stood 54 units off its
   * own octagon and missed by six, then fell through to the old hardcoded
   * "DOWNTOWN". A sign in an abandoned fairground reading DOWNTOWN was reported
   * from play, and it was wrong twice over — wrong building, and a place name that
   * only ever made sense while the city WAS the map.
   */
  const NEARBY = 170;
  let closest: { building: Building; away: number; toward: Vec2 } | null = null;
  for (const building of map.buildings) {
    const fp = building.footprint;
    const dx = centre.x - Math.max(fp.x, Math.min(centre.x, fp.x + fp.w));
    const dy = centre.y - Math.max(fp.y, Math.min(centre.y, fp.y + fp.h));
    const away = Math.hypot(dx, dy);
    if (away > NEARBY || (closest && away >= closest.away)) continue;
    const span = Math.hypot(dx, dy) || 1;
    closest = { building, away, toward: { x: -dx / span, y: -dy / span } };
  }
  if (closest) return describe(closest.building, closest.toward);

  /**
   * Nothing within reach at all. The map's own name, not a district's: a sign has
   * to say something, and the sheet is the only thing left that is certainly true.
   */
  return { title: map.name.toUpperCase(), detail: "", open: { x: 0, y: -1 } };
}

/**
 * The one sign a bot at `position` is reading, or null.
 *
 * Nearest wins, and only one at a time: two labels fighting over the same patch of
 * street is exactly the floating-UI clutter the contract forbids. Ties break on id so
 * the answer never flickers between two equidistant signs.
 */
export function signReadingAt(
  map: MapDocument,
  floorId: string,
  position: Vec2,
  signs: readonly MapObject[],
): SignReading | null {
  let best: MapObject | null = null;
  let bestAway = Number.POSITIVE_INFINITY;
  for (const sign of signs) {
    const away = distance(position, { x: sign.x + sign.w / 2, y: sign.y + sign.h / 2 });
    if (away > SIGN_READ_RANGE) continue;
    if (away < bestAway || (away === bestAway && best !== null && sign.id < best.id)) {
      best = sign;
      bestAway = away;
    }
  }
  if (!best) return null;
  const span = SIGN_READ_RANGE - SIGN_FULL_RANGE;
  const strength = bestAway <= SIGN_FULL_RANGE
    ? 1
    : Math.max(0, Math.min(1, (SIGN_READ_RANGE - bestAway) / span));
  return { sign: best, strength, ...signText(map, best) };
}

/** Every sign on a floor, so callers do not walk the whole map per frame. */
export function signsOnFloor(map: MapDocument, floorId: string): MapObject[] {
  if (floorId === OUTDOOR_FLOOR_ID) {
    return map.outdoor.objects.filter((object) => object.kind === "sign");
  }
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      if (physicsFloorId(map, floor.id) !== floorId) continue;
      return floor.objects.filter((object) => object.kind === "sign");
    }
  }
  return [];
}
