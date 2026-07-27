import { MIN_FOOTWAY, ROUTE_KINDS } from "./cityPlan";
import { defaultGameConfig } from "./config";
import { isGroundFloor } from "./mapModel";
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

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
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

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const at = { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
      const index = row * cols + col;

      // The grid rounds up, so a sheet whose size is not a multiple of CELL grows
      // a phantom strip past its own edge. Left in, it reads as a long thin hole
      // in every such map and there is nothing an author could do about it.
      if (at.x > map.width || at.y > map.height) {
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

/**
 * Can a bot leave this door and get to a street?
 *
 * Two conditions, and both matter. Stepping out has to land on named ground —
 * pavement, forecourt, yard — rather than on leftover nothing. And that ground
 * has to connect to a carriageway, or it is a courtyard the door opens into
 * rather than a way out.
 */
function approachIssues(map: MapDocument, ground: Ground, radius: number): CityIssue[] {
  const issues: CityIssue[] = [];
  const publicNetwork = new Set<number>();
  for (const group of components(ground, (kind) => kind === "route" || kind === "road")) {
    if (group.some((cell) => ground.kind[cell] === "road")) for (const cell of group) publicNetwork.add(cell);
  }

  for (const building of map.buildings) {
    for (const { door, outward } of streetDoors(building)) {
      const at = { x: door.x + outward.x * (radius + CELL), y: door.y + outward.y * (radius + CELL) };
      const col = Math.floor(at.x / CELL);
      const row = Math.floor(at.y / CELL);
      const index = row * ground.cols + col;
      if (col < 0 || row < 0 || col >= ground.cols || row >= ground.rows) continue;
      if (publicNetwork.has(index)) continue;

      const standing = ground.kind[index];
      issues.push({
        kind: "entrance-without-approach",
        subject: `${building.id}:${door.id}`,
        message: standing === "route"
          ? `${building.id} door at ${door.x},${door.y} opens onto ground that never reaches a carriageway`
          : `${building.id} door at ${door.x},${door.y} opens onto ${standing} ground — it needs an approach to the footway`,
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
      if (footways.some((footway) => overlaps(footway, probe))) continue;
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

/** A building has to address a street, not sit in the middle of the block. */
function setbackIssues(map: MapDocument): CityIssue[] {
  const issues: CityIssue[] = [];
  for (const building of map.buildings) {
    const centre = {
      x: building.footprint.x + building.footprint.w / 2,
      y: building.footprint.y + building.footprint.h / 2,
    };
    const nearest = Math.min(...map.outdoor.roads.map((road) => distanceToRect(centre, road)
      - Math.max(building.footprint.w, building.footprint.h) / 2));
    if (nearest > MAX_SETBACK) {
      issues.push({
        kind: "building-adrift",
        subject: building.id,
        message: `${building.id} stands ${Math.round(nearest)} units off its nearest road — past ${MAX_SETBACK} a building stops addressing the street`,
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
    ...setbackIssues(map),
    ...frontageIssues(map),
    ...unassignedGroundIssues(ground),
  ];
}
