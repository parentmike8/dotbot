import { addBlueprintSpawns } from "../blueprints";
import { defaultGameConfig } from "../config";
import { DOWNTOWN_GATES, downtownRegion } from "./downtown";
import { fairground } from "./fairground";
import { railYard } from "./railYard";
import { templeRegion } from "./templeRegion";
import { fenceRun, type RegionParts } from "./regionKit";
import type { MapDocument, OutdoorPlan, WallSegment } from "../types";

/**
 * THE WORLD — four regions on one sheet, and the shape is not a rectangle.
 *
 *      x:0            2400                4200
 *   y:0 ┌───────────────┬───────────────────┐
 *       │   DOWNTOWN    │   FENCHURCH YARD  │
 *       │               │                   │
 *  1600 ├───────────────┤   (runs deeper —  │
 *       │               │    a turntable    │
 *       │ THE PLEASURE  │    and its fan    │
 *       │    GROUND     │    need the room) │
 *  1800 │               ├───────────────────┤
 *       │               │                   │
 *       │               │   THE GREAT       │
 *       │               │      TEMPLE       │
 *  3400 └───────────────┴───────────────────┘
 *
 * The regions are deliberately different sizes and the seam between the two eastern ones
 * sits 200 units below the seam between the two western ones. A four-way grid would have
 * been simpler and would have looked like a four-way grid; letting each region be as big
 * as its own subject needs is what makes the world read as geography.
 *
 * WHAT JOINS THEM. Two of Downtown's streets do not stop at the city limit, they run out
 * of it — Main St east through the yard gate as the works road, Third Ave south through
 * the fair gate as the drive. That is the whole transition device, and it is worth
 * stating why it beats blending the ground: a street carrying on is legible from inside
 * a car park at either end, whereas a gradient of terrain is only legible from above.
 * Past the yard, the ground itself takes over — an abandoned spur south out of the yard's
 * back fence, a trail east off the fair's midway — and neither of those is a road,
 * because by then you have left the part of the world that has roads.
 *
 * WHICH MAKES THE GRADIENT THE POINT. City, then working depot, then derelict fairground,
 * then ruin. Every region is older and less kept than the one before it, so how far you
 * have come is something you can see rather than something the HUD tells you. It is also
 * why the boundaries are walls with gates rather than open ground: a gate makes each
 * region a place you enter, and four regions bleeding into each other would be one big
 * field with different textures on it.
 */

const WIDTH = 4200;
const HEIGHT = 3400;
const EDGE = DOWNTOWN_GATES.edge;

/** Where the city ends. Both are shared boundaries, so both live here rather than in a region. */
const CITY_E = DOWNTOWN_GATES.width - EDGE; // 2374
const CITY_S = DOWNTOWN_GATES.height - EDGE; // 1574
/** The yard runs 200 units deeper than the city, so its back fence is its own line. */
const YARD_S = 1774;

const REGIONS: RegionParts[] = [downtownRegion, railYard, fairground, templeRegion];

/**
 * The world's boundary and its internal walls.
 *
 * The sheet edge is the world's edge. Inside it, two runs of wall with a gate in each:
 * the city's east flank, open where Main St crosses it, and the city's south flank, open
 * where Third Ave does. The yard has its own back fence with the spur gate in it, and it
 * is authored in `railYard.ts` because it belongs to the yard rather than to any pair of
 * regions.
 *
 * The temple has no fence at all. Its boundary is the thicket line, which is authored as
 * solid objects — a wall of vegetation does the same job as a wall, and a masonry fence
 * round a jungle ruin would be somebody still maintaining it.
 */
function worldWalls(): WallSegment[] {
  return [
    { id: "edge-n", x: 0, y: 0, w: WIDTH, h: EDGE },
    { id: "edge-s", x: 0, y: HEIGHT - EDGE, w: WIDTH, h: EDGE },
    { id: "edge-w", x: 0, y: 0, w: EDGE, h: HEIGHT },
    { id: "edge-e", x: WIDTH - EDGE, y: 0, w: EDGE, h: HEIGHT },

    // The city's east flank, with the Main St gate. It carries on past the city's own
    // south-east corner to meet the yard's back fence, so the yard is closed on its west
    // side for its full depth.
    ...fenceRun("city-east", "v", CITY_E, 0, YARD_S, EDGE, [DOWNTOWN_GATES.east]),
    // The city's south flank, with the Third Ave gate.
    ...fenceRun("city-south", "h", CITY_S, 0, CITY_E, EDGE, [DOWNTOWN_GATES.south]),
  ];
}

function collect<T>(pick: (region: RegionParts) => T[] | undefined): T[] {
  return REGIONS.flatMap((region) => pick(region) ?? []);
}

function outdoor(): OutdoorPlan {
  return {
    roads: collect((region) => region.roads),
    surfaces: collect((region) => region.surfaces),
    regions: collect((region) => region.regions),
    parks: collect((region) => region.parks),
    walls: [...worldWalls(), ...collect((region) => region.walls)],
    barriers: collect((region) => region.barriers),
    objects: collect((region) => region.objects),
    dotSpawns: collect((region) => region.dotSpawns),
  };
}

const authoredWorld: MapDocument = {
  id: "world",
  name: "The Reach",
  width: WIDTH,
  height: HEIGHT,
  outdoor: outdoor(),
  buildings: collect((region) => region.buildings),
  extractionPoints: collect((region) => region.extractionPoints),
  insertionPoints: collect((region) => region.insertionPoints),
  botSpawns: collect((region) => region.botSpawns),
};

/**
 * Blueprint Dots: one per scannable object kind in every building, placed on the most
 * open side of the object it belongs to.
 *
 * The argument is the BOT RADIUS, not a count — the placer needs it to know what
 * "bot-clear" means. Reading it as a count and passing 89 was instructive: every
 * building in the world failed at once, because with an 89-unit bot nothing on any floor
 * has clearance, and the error named the first casualty rather than the cause.
 */
export const worldMap = addBlueprintSpawns(authoredWorld, defaultGameConfig.botRadius);

/** Exported for the region audit and for anything that needs to name the seams. */
export const WORLD_BOUNDS = { width: WIDTH, height: HEIGHT, cityEast: CITY_E, citySouth: CITY_S, yardSouth: YARD_S };
