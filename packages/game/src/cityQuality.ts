import { MIN_FOOTWAY, ROUTE_KINDS } from "./cityPlan";
import { defaultGameConfig } from "./config";
import { polygonContains, rectsOverlap } from "./geometry";
import { isGroundFloor, physicsFloorId } from "./mapModel";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { Building, Doorway, MapDocument, Rect, Vec2 } from "./types";

/**
 * City-scale quality: whether the world *between* the buildings is a place.
 *
 * `mapQuality.ts` audits one floor at a time and is good at it, but it has
 * nothing to say about the thing a player sees first. Downtown passed every
 * interior rule while reading as four boxes dropped on a car park: no footway
 * along a street, nothing joining a road to a door, and hundreds of square metres
 * of paving with no reason to exist.
 *
 * Every rule here is about a *relationship* — entrance to street, frontage to
 * kerb, named ground to leftover ground — because that is what "lived-in" reduces
 * to once you have to check it mechanically.
 *
 * The rules are deliberately stricter than the first draft of this file, which
 * probed for empty space in a straight line out of each door. That version passed
 * a map with no pavement anywhere, because an undifferentiated paved plane is
 * walkable in every direction. Asking instead "does this door reach the public
 * network, and does that network reach a carriageway" is the question that was
 * meant all along.
 */

export type CityIssue = {
  kind:
    | "entrance-without-approach"
    | "street-without-footway"
    | "building-adrift"
    | "unassigned-ground"
    | "road-without-frontage";
  /** What the issue is about: a building id, a road id, or a coordinate. */
  subject: string;
  message: string;
};

export { MIN_FOOTWAY };
/** Past this from its nearest road a building has stopped addressing the street. */
export const MAX_SETBACK = 220;
/**
 * Leftover ground smaller than this is a corner, not a hole. Roughly a 160-unit
 * square: big enough to stand a bot in and wonder what it is for.
 */
export const MIN_UNASSIGNED_AREA = 160 * 160;
const CELL = 16;

function rectHasPoint(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h;
}

function distanceToRect(point: Vec2, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/**
 * The last match, not the first — because regions are drawn in order and a later
 * one laps over an earlier one on purpose. Reading the *first* match instead put a
 * shrine's court under the jungle it was cut out of: the audit saw undergrowth
 * where a player would be standing on stone.
 */
function findLast<T>(items: readonly T[], accept: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) if (accept(items[i])) return items[i];
  return undefined;
}

/** Every ground-floor doorway that sits on a building's perimeter, and its outward normal. */
function streetDoors(building: Building): Array<{ door: Doorway; outward: Vec2 }> {
  const ground = building.floors.find(isGroundFloor);
  if (!ground) return [];
  const fp = building.footprint;
  const tol = 14;
  const out: Array<{ door: Doorway; outward: Vec2 }> = [];
  for (const door of ground.doorways) {
    if (door.dir === "h" && Math.abs(door.y - fp.y) <= tol) out.push({ door, outward: { x: 0, y: -1 } });
    else if (door.dir === "h" && Math.abs(door.y - (fp.y + fp.h)) <= tol) out.push({ door, outward: { x: 0, y: 1 } });
    else if (door.dir === "v" && Math.abs(door.x - fp.x) <= tol) out.push({ door, outward: { x: -1, y: 0 } });
    else if (door.dir === "v" && Math.abs(door.x - (fp.x + fp.w)) <= tol) out.push({ door, outward: { x: 1, y: 0 } });
  }
  return out;
}

/**
 * How the sheet is spent, cell by cell.
 *
 * `built` and `route` are separate because a surface drawn under a building is
 * not ground anyone stands on, and counting it would let a plan claim coverage it
 * does not have.
 */
type GroundKind = "built" | "route" | "quiet" | "road" | "unassigned" | "offsheet";

type Ground = {
  cols: number;
  rows: number;
  kind: GroundKind[];
};

function classifyGround(map: MapDocument): Ground {
  const cols = Math.ceil(map.width / CELL);
  const rows = Math.ceil(map.height / CELL);
  const kind: GroundKind[] = new Array(cols * rows).fill("unassigned");
  const surfaces = map.outdoor.surfaces ?? [];
  const regions = map.outdoor.regions ?? [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const at = { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
      const index = row * cols + col;

      /**
       * The grid rounds up, so a sheet whose size is not a multiple of CELL grows a
       * phantom strip past its own edge. Left in, it reads as a long thin hole in every
       * such map and there is nothing an author could do about it.
       *
       * `>=`, not `>`. A cell centred exactly ON `map.width` is outside the sheet — the
       * rightmost point of the world IS `map.width` — and with `>` it counted as ground
       * nobody had named. Downtown was 2400 x 1600 and happened to dodge it; the world's
       * 4200 divides by 16 to a half, so its last column landed on the line and reported
       * two long thin holes down the east and south edges that no author could fill.
       */
      if (at.x >= map.width || at.y >= map.height) {
        kind[index] = "offsheet";
        continue;
      }

      if (map.buildings.some((building) => rectHasPoint(building.footprint, at))) {
        kind[index] = "built";
        continue;
      }
      // The map edge is wall, not ground; nothing is meant to happen there.
      if (map.outdoor.walls.some((wall) => rectHasPoint(wall, at))) {
        kind[index] = "built";
        continue;
      }
      if (map.outdoor.roads.some((road) => rectHasPoint(road, at))) {
        kind[index] = "road";
        continue;
      }
      /**
       * A region is checked before the rect surfaces it may lap over, because that
       * lapping is the point: weeds across a midway, ballast over a yard. The last
       * thing laid down is what a player is standing on.
       */
      const region = findLast(regions, (candidate) => polygonContains(candidate.points, at));
      if (region) {
        kind[index] = ROUTE_KINDS.has(region.kind) ? "route" : "quiet";
        continue;
      }
      const surface = surfaces.find((candidate) => rectHasPoint(candidate, at));
      if (surface) {
        kind[index] = ROUTE_KINDS.has(surface.kind) ? "route" : "quiet";
        continue;
      }
      if (map.outdoor.parks.some((park) => rectHasPoint(park, at))) {
        kind[index] = "quiet";
        continue;
      }
    }
  }
  return { cols, rows, kind };
}

/** Connected runs of cells the predicate accepts, four-connected. */
function components(ground: Ground, accept: (kind: GroundKind) => boolean): number[][] {
  const { cols, rows, kind } = ground;
  const seen = new Uint8Array(cols * rows);
  const found: number[][] = [];
  for (let start = 0; start < kind.length; start += 1) {
    if (seen[start] || !accept(kind[start])) continue;
    const group: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop()!;
      group.push(at);
      const col = at % cols;
      const row = (at - col) / cols;
      const neighbours = [
        col > 0 ? at - 1 : -1,
        col < cols - 1 ? at + 1 : -1,
        row > 0 ? at - cols : -1,
        row < rows - 1 ? at + cols : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || seen[next] || !accept(kind[next])) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    found.push(group);
  }
  return found;
}

/** Cell index for a world point, or −1 if it is off the grid. */
function cellAt(ground: Ground, at: Vec2): number {
  const col = Math.floor(at.x / CELL);
  const row = Math.floor(at.y / CELL);
  if (col < 0 || row < 0 || col >= ground.cols || row >= ground.rows) return -1;
  return row * ground.cols + col;
}

/**
 * The ground a player can actually get to and away from.
 *
 * This used to be anchored on a carriageway: the network was every run of route
 * ground touching a road, and a door not on it failed. That was right for a city
 * and wrong for a world. A temple in the jungle has no roads, so every one of its
 * doors failed a rule about traffic — and an exemption would have been the wrong
 * fix, because the rule underneath is not about roads at all. It is: *a door has
 * to connect to where players arrive and where they leave.*
 *
 * So the anchors are the insertion and extraction points, which is what a
 * carriageway was standing in for. In Downtown that is the same network it always
 * was, because that is where a squad lands and extracts. In the temple it is the
 * clearing the drop puts you in. No region needs excusing, and the rule got
 * stricter rather than looser: a road nobody can arrive on no longer counts.
 */
function publicNetwork(map: MapDocument, ground: Ground): Set<number> {
  const anchors: Vec2[] = [
    ...map.insertionPoints
      .filter((point) => physicsFloorId(map, point.floorId ?? OUTDOOR_FLOOR_ID) === OUTDOOR_FLOOR_ID)
      .map((point) => point.position),
    ...map.extractionPoints.map((point) => ({
      x: point.rect.x + point.rect.w / 2,
      y: point.rect.y + point.rect.h / 2,
    })),
  ];
  const anchorCells = new Set(anchors.map((at) => cellAt(ground, at)).filter((cell) => cell >= 0));

  const network = new Set<number>();
  for (const group of components(ground, (kind) => kind === "route" || kind === "road")) {
    if (group.some((cell) => anchorCells.has(cell))) for (const cell of group) network.add(cell);
  }
  return network;
}

/**
 * Can a bot leave this door and get anywhere?
 *
 * Two conditions, and both matter. Stepping out has to land on named ground —
 * pavement, forecourt, yard, ballast, clearing — rather than on leftover nothing.
 * And that ground has to join the network a squad arrives and extracts on, or it is
 * a courtyard the door opens into rather than a way out.
 */
function approachIssues(map: MapDocument, ground: Ground, radius: number): CityIssue[] {
  const issues: CityIssue[] = [];
  const network = publicNetwork(map, ground);

  for (const building of map.buildings) {
    for (const { door, outward } of streetDoors(building)) {
      const at = { x: door.x + outward.x * (radius + CELL), y: door.y + outward.y * (radius + CELL) };
      const index = cellAt(ground, at);
      if (index < 0) continue;
      if (network.has(index)) continue;

      const standing = ground.kind[index];
      issues.push({
        kind: "entrance-without-approach",
        subject: `${building.id}:${door.id}`,
        message: standing === "route"
          ? `${building.id} door at ${door.x},${door.y} opens onto ground that never reaches an arrival point`
          : `${building.id} door at ${door.x},${door.y} opens onto ${standing} ground — it needs an approach to the network`,
      });
    }
  }
  return issues;
}

/**
 * A building that addresses a street needs pavement between it and the traffic.
 *
 * Checked per side rather than per street, because the failure is one-sided: a
 * frontage with the carriageway running straight up to its door is the thing
 * being ruled out, and the far side of the same street may be fine.
 */
function footwayIssues(map: MapDocument): CityIssue[] {
  const issues: CityIssue[] = [];
  const footways = (map.outdoor.surfaces ?? []).filter((surface) => surface.kind === "footway");
  for (const road of map.outdoor.roads) {
    const horizontal = road.w >= road.h;
    const bands: Array<{ side: string; probe: Rect }> = horizontal
      ? [
        { side: "north", probe: { x: road.x, y: road.y - MIN_FOOTWAY, w: road.w, h: MIN_FOOTWAY } },
        { side: "south", probe: { x: road.x, y: road.y + road.h, w: road.w, h: MIN_FOOTWAY } },
      ]
      : [
        { side: "west", probe: { x: road.x - MIN_FOOTWAY, y: road.y, w: MIN_FOOTWAY, h: road.h } },
        { side: "east", probe: { x: road.x + road.w, y: road.y, w: MIN_FOOTWAY, h: road.h } },
      ];

    for (const { side, probe } of bands) {
      const fronting = map.buildings.filter((building) => {
        const fp = building.footprint;
        const along = horizontal
          ? fp.x < road.x + road.w && road.x < fp.x + fp.w
          : fp.y < road.y + road.h && road.y < fp.y + fp.h;
        if (!along) return false;
        const beyond = horizontal
          ? (side === "north" ? fp.y + fp.h <= road.y : fp.y >= road.y + road.h)
          : (side === "west" ? fp.x + fp.w <= road.x : fp.x >= road.x + road.w);
        return beyond && distanceToRect({
          x: fp.x + fp.w / 2,
          y: fp.y + fp.h / 2,
        }, road) - Math.max(fp.w, fp.h) / 2 < MAX_SETBACK;
      });
      if (!fronting.length) continue;
      if (footways.some((footway) => rectsOverlap(footway, probe))) continue;
      issues.push({
        kind: "street-without-footway",
        subject: road.id,
        message: `${road.id} has ${fronting.map((building) => building.id).join(", ")} fronting its ${side} side `
          + `with no footway between them and the carriageway`,
      });
    }
  }
  return issues;
}

/**
 * A building has to address the public ground, not stand in a field.
 *
 * This measured distance to the nearest *road* until the world grew past the city.
 * Under that rule a pyramid on a ceremonial court and a roundhouse on a rail yard
 * were both "adrift" while a shed dropped on a verge beside a street passed — the
 * rule had latched onto the city's usual answer instead of the question.
 *
 * The question is whether the building fronts ground somebody would walk on. In
 * Downtown that is a footway off a carriageway and nothing changes. Elsewhere it is
 * a yard, a court, a clearing. What still fails, and is the whole point, is a
 * building with unnamed ground all round it: a field is not a frontage.
 */
function setbackIssues(map: MapDocument, ground: Ground): CityIssue[] {
  const issues: CityIssue[] = [];
  const network = publicNetwork(map, ground);

  for (const building of map.buildings) {
    const fp = building.footprint;
    // Probe a ring at MAX_SETBACK round the footprint rather than measuring to the
    // nearest surface rect: route ground is a polygon soup now, and "is there any
    // of it within reach of my frontage" is the thing being asked either way.
    let nearest = Infinity;
    const step = CELL;
    for (let reach = step; reach <= MAX_SETBACK && nearest === Infinity; reach += step) {
      const band: Vec2[] = [];
      for (let x = fp.x - reach; x <= fp.x + fp.w + reach; x += step) {
        band.push({ x, y: fp.y - reach }, { x, y: fp.y + fp.h + reach });
      }
      for (let y = fp.y - reach; y <= fp.y + fp.h + reach; y += step) {
        band.push({ x: fp.x - reach, y }, { x: fp.x + fp.w + reach, y });
      }
      if (band.some((at) => network.has(cellAt(ground, at)))) nearest = reach;
    }

    if (nearest === Infinity) {
      issues.push({
        kind: "building-adrift",
        subject: building.id,
        message: `${building.id} has no public ground within ${MAX_SETBACK} units of its frontage `
          + `— past that a building has stopped addressing anything`,
      });
    }
  }
  return issues;
}

/**
 * Ground nobody decided anything about.
 *
 * This replaced a distance heuristic that asked how far a point was from the
 * nearest *thing*. That version was satisfiable by scattering objects, which is
 * the disease rather than the cure. Coverage is the honest question: every part
 * of the sheet is either built on, driven on, or has a named use, and whatever is
 * left is a piece of the map that was never finished.
 *
 * Reported per contiguous region, so a plan gets one entry per hole to fill
 * rather than several hundred cells to read through.
 */
function unassignedGroundIssues(ground: Ground): CityIssue[] {
  const cellArea = CELL * CELL;
  return components(ground, (kind) => kind === "unassigned")
    .map((group) => {
      let minCol = Infinity; let minRow = Infinity; let maxCol = -1; let maxRow = -1;
      for (const cell of group) {
        const col = cell % ground.cols;
        const row = (cell - col) / ground.cols;
        minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
        minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
      }
      return { area: group.length * cellArea, minCol, minRow, maxCol, maxRow };
    })
    .filter((region) => region.area >= MIN_UNASSIGNED_AREA)
    .sort((a, b) => b.area - a.area)
    .map((region) => ({
      kind: "unassigned-ground" as const,
      subject: `${region.minCol * CELL},${region.minRow * CELL}`,
      message: `${Math.round(region.area / 1000)}k units² of ground from `
        + `${region.minCol * CELL},${region.minRow * CELL} to ${(region.maxCol + 1) * CELL},${(region.maxRow + 1) * CELL} `
        + `has no use — give it one, or build on it`,
    }));
}

/** Every road wants something built along it, or it is a road to nowhere. */
function frontageIssues(map: MapDocument): CityIssue[] {
  const issues: CityIssue[] = [];
  for (const road of map.outdoor.roads) {
    const fronting = map.buildings.filter((building) => distanceToRect({
      x: building.footprint.x + building.footprint.w / 2,
      y: building.footprint.y + building.footprint.h / 2,
    }, road) - Math.max(building.footprint.w, building.footprint.h) / 2 < MAX_SETBACK);
    if (!fronting.length) {
      issues.push({
        kind: "road-without-frontage",
        subject: road.id,
        message: `${road.id} has nothing built along it`,
      });
    }
  }
  return issues;
}

export function auditCity(map: MapDocument, radius = defaultGameConfig.botRadius): CityIssue[] {
  const ground = classifyGround(map);
  return [
    ...approachIssues(map, ground, radius),
    ...footwayIssues(map),
    ...setbackIssues(map, ground),
    ...frontageIssues(map),
    ...unassignedGroundIssues(ground),
  ];
}
