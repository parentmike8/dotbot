import { buildingContaining, physicsFloorId } from "./mapModel";
import { distance } from "./math";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Building, MapDocument, MapObject, Rect, Vec2 } from "./types";

/**
 * What a sign says, and when you are close enough to read it.
 *
 * The lit-model language originally painted one building name across each footprint.
 * That was map annotation rather than part of the place, and it could not say anything
 * else. Physical signs replace those captions and also let an extraction identify
 * itself without writing its name directly on the ground.
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
 * The nearest point on a rectangle and the direction from it to `at`.
 *
 * The direction is the side of the target the sign stands on, which is also the side
 * its words should face. All authored signs stand outside their target; the inside
 * fallback only keeps the function deterministic for malformed input.
 */
function rectDistance(rect: Rect, at: Vec2): { away: number; open: Vec2 } {
  const x = Math.max(rect.x, Math.min(at.x, rect.x + rect.w));
  const y = Math.max(rect.y, Math.min(at.y, rect.y + rect.h));
  const dx = at.x - x;
  const dy = at.y - y;
  const away = Math.hypot(dx, dy);
  if (away > 0) return { away, open: { x: dx / away, y: dy / away } };

  const edges = [
    { gap: at.y - rect.y, open: { x: 0, y: -1 } },
    { gap: rect.x + rect.w - at.x, open: { x: 1, y: 0 } },
    { gap: rect.y + rect.h - at.y, open: { x: 0, y: 1 } },
    { gap: at.x - rect.x, open: { x: -1, y: 0 } },
  ];
  return { away: 0, open: edges.sort((a, b) => a.gap - b.gap)[0].open };
}

function segmentDistance(at: Vec2, a: Vec2, b: Vec2): { away: number; open: Vec2 } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const span = vx * vx + vy * vy;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * vx + (at.y - a.y) * vy) / span));
  const dx = at.x - (a.x + vx * t);
  const dy = at.y - (a.y + vy * t);
  const away = Math.hypot(dx, dy);
  return { away, open: away === 0 ? { x: 0, y: -1 } : { x: dx / away, y: dy / away } };
}

/**
 * Distance to the real outline, not its bounding rectangle.
 *
 * This matters most at the roundhouse: its turntable occupies a large empty corner of
 * the fan's bounding box. Treating that box as the shed made a sign beside the table
 * announce ROUNDHOUSE instead of the extraction standing next to it.
 */
function buildingDistance(building: Building, at: Vec2): { away: number; open: Vec2 } {
  if (!building.outline?.length) return rectDistance(building.footprint, at);
  let closest = { away: Number.POSITIVE_INFINITY, open: { x: 0, y: -1 } };
  for (let i = 0; i < building.outline.length; i += 1) {
    const candidate = segmentDistance(at, building.outline[i], building.outline[(i + 1) % building.outline.length]);
    if (candidate.away < closest.away) closest = candidate;
  }
  return closest;
}

/**
 * What this sign has to say, from the map around it.
 *
 * A sign standing on or against a building names it and counts its floors. A sign
 * beside an extraction names the pad and says what it is. Both are read from the map,
 * so a rename or a new floor updates every sign that mentions it for free.
 */
export function signText(
  map: MapDocument,
  sign: MapObject,
): { title: string; detail: string; open: Vec2 } {
  const centre = { x: sign.x + sign.w / 2, y: sign.y + sign.h / 2 };
  const authoredOpen: Vec2 | null = sign.facing === "N"
    ? { x: 0, y: -1 }
    : sign.facing === "E"
      ? { x: 1, y: 0 }
      : sign.facing === "S"
        ? { x: 0, y: 1 }
        : sign.facing === "W"
          ? { x: -1, y: 0 }
          : null;
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
  const describe = (building: Building, open: Vec2) => {
    // ROOF is the exterior, not a storey you can stand on, so it is not counted.
    const storeys = building.floors.filter((floor) => floor.label !== "ROOF").length;
    return {
      title: building.name,
      detail: `${storeys} ${storeys === 1 ? "FLOOR" : "FLOORS"}`,
      open: authoredOpen ?? open,
    };
  };

  const TARGET_REACH = 170;
  let nearestExtraction: {
    point: MapDocument["extractionPoints"][number];
    away: number;
    open: Vec2;
  } | null = null;
  for (const point of map.extractionPoints) {
    const relation = rectDistance(point.rect, centre);
    if (relation.away > TARGET_REACH || (nearestExtraction && relation.away >= nearestExtraction.away)) continue;
    nearestExtraction = { point, ...relation };
  }

  let nearestBuilding: { building: Building; away: number; open: Vec2 } | null = null;
  for (const probe of probes) {
    const building = buildingContaining(map, probe.at);
    if (!building) continue;
    const relation = buildingDistance(building, centre);
    nearestBuilding = {
      building,
      away: buildingContaining(map, centre) === building ? 0 : relation.away,
      // The probe is authoritative when the plate sits just inside a wall.
      open: probe.at === centre ? relation.open : { x: -probe.toward.x, y: -probe.toward.y },
    };
    break;
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
  if (!nearestBuilding) {
    for (const building of map.buildings) {
      const relation = buildingDistance(building, centre);
      if (relation.away > TARGET_REACH || (nearestBuilding && relation.away >= nearestBuilding.away)) continue;
      nearestBuilding = { building, ...relation };
    }
  }

  if (nearestExtraction && (!nearestBuilding || nearestExtraction.away < nearestBuilding.away)) {
    return {
      title: nearestExtraction.point.name,
      detail: "EXTRACTION",
      open: authoredOpen ?? nearestExtraction.open,
    };
  }
  if (nearestBuilding) return describe(nearestBuilding.building, nearestBuilding.open);

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
