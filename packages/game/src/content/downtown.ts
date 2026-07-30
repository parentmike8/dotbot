import { addBlueprintSpawns } from "../blueprints";
import { compileCityPlan, type CityPlan } from "../cityPlan";
import { beaconHouse } from "./beaconHouse";
import { civicTower } from "./civicTower";
import { lot6Depot } from "./lot6Depot";
import { mercyClinic } from "./mercyClinic";
import type { RegionParts } from "./regionKit";
import type {
  BotSpawn,
  DotSpawn,
  MapDocument,
  MapObject,
  OutdoorPlan,
  WallSegment,
} from "../types";

/**
 * Downtown — the first DotBot map, authored entirely as data.
 *
 * A four-building block on a 2400 x 1600 sheet:
 *
 *   NW  Mercy Clinic   hospital     GROUND + F1
 *   NE  Civic Tower    office       GROUND + F1–F7 + ROOF (8 usable floors)
 *   SW  Lot 6 Depot    warehouse    GROUND + B1
 *   SE  Beacon House   residential  GROUND + F1 + ROOF, courtyard park east
 *
 * Main St runs east-west and Third Ave north-south. Three extraction pads: north
 * plaza, depot yard, courtyard.
 *
 * The exterior is authored street-first through `cityPlan.ts` — see the comment
 * there for why the order matters. The short version: the first draft of this map
 * placed the four buildings and then drew roads near them, and the result read as
 * boxes on a car park because the ground between them was never anything. Now the
 * streets come first, the footways come from the streets, and every remaining
 * piece of ground is given a use. `auditCity` fails the map if any is left over.
 *
 * Authoring rules learned the hard way:
 *  - every object earns its place; no filler rows, no scattered clutter;
 *  - circulation lanes stay open — validation flood-fills every floor;
 *  - windows are composed per facade, never sprayed;
 *  - repetition is reserved for things that truly repeat (racks, ward bays);
 *  - street furniture keeps a rhythm, and entrances punch holes in it.
 */

const MAP_W = 2400;
const MAP_H = 1600;
const EDGE = 26;

// ---------------------------------------------------------------------------
// The street grid, and everything measured off it
// ---------------------------------------------------------------------------

const MAIN_ST_Y = 800;
const THIRD_AVE_X = 1220;
const CARRIAGEWAY = 120;
const FOOTWAY = 96;

/** Kerb lines and footway backs, derived so nothing can drift out of step. */
const MAIN_N_KERB = MAIN_ST_Y - CARRIAGEWAY / 2; // 740
const MAIN_N_BACK = MAIN_N_KERB - FOOTWAY; //       644
const MAIN_S_KERB = MAIN_ST_Y + CARRIAGEWAY / 2; // 860
const MAIN_S_BACK = MAIN_S_KERB + FOOTWAY; //       956
const AVE_W_KERB = THIRD_AVE_X - CARRIAGEWAY / 2; // 1160
const AVE_W_BACK = AVE_W_KERB - FOOTWAY; //          1064
const AVE_E_KERB = THIRD_AVE_X + CARRIAGEWAY / 2; // 1280
const AVE_E_BACK = AVE_E_KERB + FOOTWAY; //          1376

/**
 * A footway is a furniture strip plus a clear walking strip.
 *
 * Street furniture is solid — see `SOLID_KINDS` — so where it stands decides
 * whether the pavement still works. Trees at `kerb - 38` with a 22 radius take
 * the middle 44 units of a 96-deep footway and leave 36 behind and 16 in front:
 * a 48-unit bot fits through neither, so every tree severed the footway it was
 * decorating. Pushed against the kerb at an 18 radius they occupy `kerb-38..kerb-2`
 * and leave a 58-unit clear walking strip, which is what `footway-not-walkable`
 * in `cityQuality.ts` now checks for.
 */
const FURNITURE_OFFSET = 20;
const STREET_TREE_R = 18;
const MAIN_N_FURNITURE = MAIN_N_KERB - FURNITURE_OFFSET;
const MAIN_S_FURNITURE = MAIN_S_KERB + FURNITURE_OFFSET;

const cityPlan: CityPlan = {
  streets: [
    { id: "main-st", from: { x: EDGE, y: MAIN_ST_Y }, to: { x: MAP_W - EDGE, y: MAIN_ST_Y }, width: CARRIAGEWAY, footway: FOOTWAY },
    { id: "third-ave", from: { x: THIRD_AVE_X, y: EDGE }, to: { x: THIRD_AVE_X, y: MAP_H - EDGE }, width: CARRIAGEWAY, footway: FOOTWAY },
  ],

  /**
   * Every piece of block, named.
   *
   * Read them quadrant by quadrant. The pattern in each is the same: the face a
   * building presents to the street gets a forecourt at its door and planting
   * either side, and the back gets a yard. Which face is which is the whole
   * character of the building — the clinic turns its ambulance bay away from Main
   * St, the depot turns its loading doors towards it because that is what a depot
   * is for.
   */
  patches: [
    // -- NW: Mercy Clinic ---------------------------------------------------
    // Ambulance apron down the west flank, out of public sight.
    { id: "nw-clinic-yard", kind: "yard", x: EDGE, y: EDGE, w: 174, h: MAIN_N_BACK - EDGE },
    // Planted strip behind the clinic; nothing routes through it.
    { id: "nw-clinic-back", kind: "verge", x: 200, y: EDGE, w: 620, h: 114 },
    // The north plaza, holding the extraction pad.
    { id: "nw-plaza", kind: "plaza", x: 820, y: EDGE, w: AVE_W_BACK - 820, h: 274 },
    // Clinic service yard: deliveries, bins, and the staff door at 814,528.
    { id: "nw-service-yard", kind: "yard", x: 820, y: 300, w: AVE_W_BACK - 820, h: MAIN_N_BACK - 300 },
    // Main St frontage: the entrance forecourt, planting either side of it.
    { id: "nw-clinic-planting-w", kind: "verge", x: 200, y: 580, w: 160, h: MAIN_N_BACK - 580 },
    { id: "nw-clinic-forecourt", kind: "forecourt", x: 360, y: 580, w: 200, h: MAIN_N_BACK - 580 },
    { id: "nw-clinic-planting-e", kind: "verge", x: 560, y: 580, w: 260, h: MAIN_N_BACK - 580 },

    // -- NE: Civic Tower ----------------------------------------------------
    // Third Ave frontage: forecourt at the west door, planting above and below.
    { id: "ne-civic-verge-nw", kind: "verge", x: AVE_E_BACK, y: EDGE, w: 1480 - AVE_E_BACK, h: 224 },
    { id: "ne-civic-forecourt-w", kind: "forecourt", x: AVE_E_BACK, y: 250, w: 1480 - AVE_E_BACK, h: 180 },
    { id: "ne-civic-verge-sw", kind: "verge", x: AVE_E_BACK, y: 430, w: 1480 - AVE_E_BACK, h: MAIN_N_BACK - 430 },
    { id: "ne-civic-back", kind: "verge", x: 1480, y: EDGE, w: 560, h: 94 },
    // Staff car park east, entered off Main St.
    { id: "ne-car-park", kind: "yard", x: 2040, y: EDGE, w: MAP_W - EDGE - 2040, h: MAIN_N_BACK - EDGE },
    // Main St frontage.
    { id: "ne-civic-planting-sw", kind: "verge", x: 1480, y: 540, w: 220, h: MAIN_N_BACK - 540 },
    { id: "ne-civic-forecourt-s", kind: "forecourt", x: 1700, y: 540, w: 180, h: MAIN_N_BACK - 540 },
    { id: "ne-civic-planting-se", kind: "verge", x: 1880, y: 540, w: 160, h: MAIN_N_BACK - 540 },

    // -- SW: Lot 6 Depot ----------------------------------------------------
    // The whole block is yard. A depot is mostly yard; pretending otherwise is
    // what produced a warehouse sitting on ornamental paving.
    { id: "sw-depot-yard", kind: "yard", x: EDGE, y: MAIN_S_BACK, w: AVE_W_BACK - EDGE, h: MAP_H - EDGE - MAIN_S_BACK },

    // -- SE: Beacon House ---------------------------------------------------
    { id: "se-beacon-verge-w", kind: "verge", x: AVE_E_BACK, y: MAIN_S_BACK, w: 1560 - AVE_E_BACK, h: 1420 - MAIN_S_BACK },
    { id: "se-beacon-verge-nw", kind: "verge", x: 1560, y: MAIN_S_BACK, w: 140, h: 1020 - MAIN_S_BACK },
    { id: "se-beacon-forecourt", kind: "forecourt", x: 1700, y: MAIN_S_BACK, w: 220, h: 1020 - MAIN_S_BACK },
    { id: "se-beacon-verge-ne", kind: "verge", x: 1920, y: MAIN_S_BACK, w: 160, h: 1020 - MAIN_S_BACK },
    /**
     * The walk down Beacon's east flank into the courtyard.
     *
     * It runs all the way up to the Main St footway on purpose. Authored as a
     * path between the door and the park alone it was an island — pavement that
     * connected two private things and never met the street — which is precisely
     * what `entrance-without-approach` exists to catch, and it did.
     */
    { id: "se-park-walk", kind: "forecourt", x: 2080, y: MAIN_S_BACK, w: 68, h: 1020 - MAIN_S_BACK },
    { id: "se-beacon-verge-nne", kind: "verge", x: 2148, y: MAIN_S_BACK, w: MAP_W - EDGE - 2148, h: 1020 - MAIN_S_BACK },
    { id: "se-park-path", kind: "forecourt", x: 2080, y: 1020, w: 68, h: 400 },
    { id: "se-beacon-south", kind: "verge", x: AVE_E_BACK, y: 1420, w: MAP_W - EDGE - AVE_E_BACK, h: MAP_H - EDGE - 1420 },
  ],
};

const { roads, surfaces } = compileCityPlan(cityPlan);

// ---------------------------------------------------------------------------
// Outdoor authoring helpers
// ---------------------------------------------------------------------------

let objSeq = 0;
let dotSeq = 0;

function obj(kind: MapObject["kind"], x: number, y: number, w: number, h: number, extra: Partial<MapObject> = {}): MapObject {
  return { id: `o${objSeq++}`, kind, x, y, w, h, ...extra };
}

function tree(cx: number, cy: number, r = 24): MapObject {
  return obj("tree", cx - r, cy - r, r * 2, r * 2);
}

function dot(item: DotSpawn["item"], x: number, y: number): DotSpawn {
  return { id: `dot-${dotSeq++}`, item, position: { x, y } };
}

const DOT = {
  regen: { kind: "powerup", type: "health" },
  shield: { kind: "powerup", type: "health" },
  dash: { kind: "powerup", type: "dashOvercharge" },
  scanner: { kind: "powerup", type: "radar" },
  decoy: { kind: "powerup", type: "incognito" },
  damage: { kind: "powerup", type: "dashOvercharge" },
  rare: { kind: "powerup", type: "incognito" },
} as const satisfies Record<string, DotSpawn["item"]>;

/**
 * Positions at a steady interval, with named stretches punched out.
 *
 * The rhythm is what makes a street read as designed rather than decorated, and
 * the gaps are what stop a tree standing in a doorway or a loading bay. The first
 * draft of this map did both by hand, which is how it ended up with trees at
 * 350, 610, 870, 1420 — a spacing with no rule behind it that reads as scatter.
 */
function rhythm(from: number, to: number, step: number, clear: Array<[number, number]> = []): number[] {
  const out: number[] = [];
  for (let at = from; at <= to; at += step) {
    if (clear.some(([start, end]) => at >= start && at <= end)) continue;
    out.push(at);
  }
  return out;
}

/** Entrances and vehicle crossings on Main St's north footway. */
const MAIN_N_GAPS: Array<[number, number]> = [
  [330, 590], // clinic forecourt
  [AVE_W_BACK - 60, AVE_E_BACK + 60], // the Third Ave junction and its crossings
  [1670, 1910], // civic south forecourt
  [2040, 2200], // car park entrance
];

/** Loading doors and the junction on Main St's south footway. */
const MAIN_S_GAPS: Array<[number, number]> = [
  [280, 400], // lot 6 door 1
  [560, 680], // lot 6 door 2
  [760, 880], // lot 6 door 3
  [AVE_W_BACK - 60, AVE_E_BACK + 60],
  [1670, 1950], // beacon forecourt
];

// ---------------------------------------------------------------------------
// The block's four buildings, each authored in map source in its own file.
// ---------------------------------------------------------------------------

function outdoorPlan(): OutdoorPlan {
  const edgeWalls: WallSegment[] = [
    { id: "edge-n", x: 0, y: 0, w: MAP_W, h: EDGE },
    { id: "edge-s", x: 0, y: MAP_H - EDGE, w: MAP_W, h: EDGE },
    { id: "edge-w", x: 0, y: 0, w: EDGE, h: MAP_H },
    { id: "edge-e", x: MAP_W - EDGE, y: 0, w: EDGE, h: MAP_H },
  ];

  const objects: MapObject[] = [
    /**
     * No parked cars on Main St, deliberately.
     *
     * A car is 46 units wide against a 120-unit carriageway — 2.6 car widths — so
     * a parking lane would leave two 38-unit running lanes, narrower than the cars
     * using them. Parking lives where there is room for it: the tower's staff lot,
     * the depot yard, the clinic's ambulance apron and the bays along the depot's
     * back. Cover on the street comes from the footway trees and lamps, which are
     * solid.
     */

    // -- Main St, north footway --------------------------------------------
    ...rhythm(180, MAP_W - 180, 200, MAIN_N_GAPS).map((x) => tree(x, MAIN_N_FURNITURE, STREET_TREE_R)),
    /**
     * Lamps on the half-beat, so the two rhythms interleave rather than stack.
     *
     * `facing` is the direction the MAST ARM reaches, and on a street lamp that is always over
     * the carriageway — reported on sight when every post leaned the same way: "the ones on the
     * north side should face south and vice versa". These are on the north footway, so south.
     */
    ...rhythm(280, MAP_W - 180, 200, MAIN_N_GAPS).map((x) => obj("lampPost", x - 9, MAIN_N_KERB - 22, 18, 18, { facing: "S" })),
    obj("hydrant", 640, MAIN_N_KERB - 18, 14, 14),
    obj("hydrant", 1960, MAIN_N_KERB - 18, 14, 14),

    // -- Main St, south footway --------------------------------------------
    ...rhythm(200, MAP_W - 180, 200, MAIN_S_GAPS).map((x) => tree(x, MAIN_S_FURNITURE, STREET_TREE_R)),
    // South footway, so the arm reaches north over Main St.
    ...rhythm(300, MAP_W - 180, 200, MAIN_S_GAPS).map((x) => obj("lampPost", x - 9, MAIN_S_KERB + 4, 18, 18, { facing: "N" })),
    obj("hydrant", 900, MAIN_S_KERB + 4, 14, 14),

    /**
     * One sign per building, standing on the footway outside its own face.
     *
     * What each says is not authored here — `signs.ts` reads the building it is
     * standing against and reports its name and storey count, so a rename or a new
     * floor updates the street for free. Type the words on the sign instead and you
     * have made a second copy of the building's name that can disagree with the first.
     *
     * Placed off the kerb line rather than against the wall: a sign flush to a facade
     * is standing in the doorway approach, and the clearance validation is the thing
     * that says so.
     */
    // Against each building's own street face, not out on the carriageway: placed on
    // the kerb line the signs sat 160 units from anything and every one of them read
    // "DOWNTOWN", which is what the derived text does when it cannot find a building.
    obj("sign", 276, 592, 44, 12),
    // Against Civic's south face, east of the main entrance furniture. The first
    // position at 1640,574 read correctly but sat in the bench's cast shadow.
    obj("sign", 1886, 574, 44, 12),
    obj("sign", 458, 968, 44, 12),
    obj("sign", 1642, 986, 44, 12),

    // -- Third Ave ----------------------------------------------------------
    ...rhythm(200, 600, 200).map((y) => tree(AVE_W_KERB - FURNITURE_OFFSET, y, STREET_TREE_R)),
    ...rhythm(1020, 1420, 200).map((y) => tree(AVE_W_KERB - FURNITURE_OFFSET, y, STREET_TREE_R)),
    ...rhythm(1080, 1400, 160).map((y) => tree(AVE_E_KERB + FURNITURE_OFFSET, y, STREET_TREE_R)),
    // Third Ave runs north-south, so its arms reach east and west across it.
    obj("lampPost", AVE_W_KERB - 27, 420, 18, 18, { facing: "E" }),
    obj("lampPost", AVE_E_KERB + 9, 1180, 18, 18, { facing: "W" }),

    // -- Mercy Clinic: Main St entrance ------------------------------------
    // Benches face the street from the forecourt edge, flanking the walk.
    obj("bench", 372, 596, 22, 76, { facing: "E" }),
    obj("bench", 526, 596, 22, 76, { facing: "W" }),
    obj("bikeRack", 596, 600, 20, 90, { scannable: true }),
    obj("planter", 340, 592, 34, 34),
    obj("planter", 546, 592, 34, 34),

    // -- Mercy Clinic: ambulance apron, west flank -------------------------
    obj("parkingStall", 44, 232, 140, 76),
    obj("car", 52, 246, 124, 48, { facing: "E" }),
    obj("parkingStall", 44, 330, 140, 76),
    obj("dumpster", 54, 452, 56, 30, { solid: true }),
    obj("drum", 120, 456, 24, 24),

    // -- Mercy Clinic: service yard, east flank ----------------------------
    // Bins, drums and pallet read as one bank against the clinic's east flank,
    // clear of the staff door's walk at y 528.
    obj("dumpster", 880, 480, 56, 30, { solid: true }),
    obj("drum", 950, 484, 24, 24),
    obj("drum", 982, 484, 24, 24),
    obj("pallet", 880, 560, 48, 36),
    obj("crateStack", 1000, 560, 34, 34),
    obj("parkingStall", 940, 340, 110, 62),
    obj("car", 946, 348, 100, 46, { facing: "E" }),

    // -- North plaza --------------------------------------------------------
    obj("bench", 856, 210, 100, 22, { facing: "S", scannable: true }),
    obj("bench", 1000, 210, 100, 22, { facing: "S" }),
    obj("planter", 848, 60, 40, 34),
    obj("planter", 1010, 60, 40, 34),
    tree(900, 132, 24),
    tree(1004, 132, 24),

    // -- Civic Tower: Third Ave entrance -----------------------------------
    /**
     * Both clear of the door's line, now that a bench is solid.
     *
     * The rack ran y 268..358 and the bench y 380..470, straddling x 1392 — dead
     * across the walk out of Civic's west door at 1486,340. As ghosts they only
     * looked wrong; as colliders they made the entrance a detour, so they move
     * into the planting either side of the forecourt where a rack and a bench
     * actually belong.
     */
    obj("bikeRack", 1392, 100, 20, 90),
    obj("bench", 1392, 480, 22, 90, { facing: "E" }),
    obj("planter", 1394, 232, 34, 34),

    // -- Civic Tower: Main St entrance -------------------------------------
    obj("planter", 1712, 552, 34, 34),
    obj("planter", 1834, 552, 34, 34),
    // In the planting west of the entrance walk, not across it: at 1756,596 this
    // sat squarely between Civic's south door and the footway.
    obj("bench", 1560, 596, 100, 22, { facing: "N" }),

    // -- Civic Tower: staff car park, east ---------------------------------
    // One bay row against the east edge off a generous drive, rather than two
    // cramped columns: a car park you cannot turn in reads as a texture.
    ...rhythm(80, 500, 72).map((y) => obj("parkingStall", 2244, y, 130, 62)),
    obj("car", 2252, 88, 114, 46, { facing: "W" }),
    obj("car", 2252, 232, 114, 46, { facing: "W" }),
    obj("car", 2252, 376, 114, 46, { facing: "W" }),
    obj("car", 2252, 448, 114, 46, { facing: "W" }),
    obj("planter", 2060, 100, 40, 200),
    obj("lampPost", 2120, 340, 18, 18, { facing: "W" }),

    // -- Lot 6 Depot: yard ---------------------------------------------------
    /**
     * Everything the depot does happens in the east yard and along the back.
     *
     * The north apron and the west alley stay empty because they are the only
     * ways through: the apron is the walk to all three loading doors, and the
     * alley is the single route from Main St to the back of the site. A first
     * pass put bins down both of them, which read as dressing and behaved as a
     * blockage — `validateInsertionMap` refused to place a squad in the alley.
     */
    obj("dumpster", 880, 1060, 56, 30, { solid: true }),
    obj("dumpster", 880, 1110, 56, 30, { solid: true }),
    // Tucked against the bins rather than mid-yard: at x 960..1016 they stood in
    // the walk north from the depot pad, which is the yard's one real route.
    obj("drum", 880, 1030, 24, 24),
    obj("drum", 908, 1030, 24, 24),
    obj("pallet", 880, 1320, 48, 36),
    obj("pallet", 936, 1320, 48, 36),
    obj("lampPost", 1000, 1300, 18, 18, { facing: "N" }),
    // Staff parking along the back, out of the loading route.
    obj("parkingStall", 200, 1490, 110, 46),
    obj("parkingStall", 320, 1490, 110, 46),
    obj("car", 208, 1494, 100, 40, { facing: "E" }),
    obj("lampPost", 620, 1500, 18, 18, { facing: "N" }),

    // -- Beacon House: Main St frontage ------------------------------------
    obj("bench", 1716, 880, 100, 22, { facing: "N" }),
    obj("planter", 1706, 968, 34, 34),
    obj("planter", 1884, 968, 34, 34),
    obj("bikeRack", 1936, 966, 90, 20),

    // -- Beacon House: courtyard park --------------------------------------
    tree(2186, 1074, 24),
    tree(2308, 1108, 22),
    tree(2180, 1352, 24),
    tree(2306, 1380, 22),
    obj("bench", 2168, 1152, 100, 22, { facing: "S", scannable: true }),
    obj("bench", 2210, 1300, 100, 22, { facing: "N" }),
    obj("planter", 2150, 1032, 40, 28),
    obj("planter", 2320, 1032, 40, 28),
    /**
     * THE COURTYARD LAMP POST IS GONE, and it is the second time it has done this.
     *
     * It stood at 2244,1224 — dead centre of PARK PAD, which is 2210..2320 x 1180..1290.
     * So the extraction pad in the park had three units of clearance at its middle and no
     * navigable route to it at all, in the regression map, since street furniture became
     * solid. The note below already records it swallowing a Dot at 2250,1230 for the same
     * reason; the Dot moved and the post stayed.
     *
     * Nothing checked it, and that is the actual finding. `validateInsertionMap` proves a
     * squad FITS at every arrival point and no audit had ever asked whether the outdoor
     * plane is CONNECTED — so a pad you cannot stand on, an arrival you cannot walk out of
     * and a doorway you cannot reach were all invisible. There is a test for it now.
     *
     * Deleted rather than moved: the courtyard is 200 wide and already holds two benches,
     * four trees, two planters and a 110-unit pad. A lamp in the middle of the one open
     * space is not a thing anybody would put there.
     */

    /**
     * Extraction signs sit beside their pads, never on the approach.
     *
     * The north sign is east of the planter pair so the pad's narrow plaza stays open
     * from the street. The depot sign is east because the one useful route runs north
     * past the bins. The park sign uses the slim east verge; north and south already
     * belong to benches, and the west is the broad route into the court.
     *
     * As with every building sign above, their words are derived in `signs.ts`.
     */
    obj("sign", 1060, 114, 44, 12),
    obj("sign", 1038, 1194, 44, 12),
    obj("sign", 2328, 1214, 44, 12),
  ];

  /**
   * Outdoor Dots, one per quadrant plus the two street corridors.
   *
   * Both of the first two positions were inside a collider once street furniture
   * became solid: 1000,700 was in a footway tree and 2250,1230 was inside the
   * courtyard lamp post. They sit in the clear walking strip and in open park now.
   * `auditDotPlacement` fails the map if a Dot lands somewhere a bot cannot stand.
   */
  const dotSpawns: DotSpawn[] = [
    dot(DOT.dash, 1020, 676),
    dot(DOT.dash, 1220, 420),
    dot(DOT.scanner, 2200, 690),
    dot(DOT.shield, 2320, 600),
    dot(DOT.decoy, 520, 1520),
    dot(DOT.regen, 2200, 1240),
  ];

  return {
    roads,
    surfaces,
    parks: [{ id: "beacon-courtyard", x: 2148, y: 1020, w: 212, h: 400 }],
    walls: edgeWalls,
    objects,
    dotSpawns,
  };
}

// ---------------------------------------------------------------------------
// Spawns and assembly
// ---------------------------------------------------------------------------

const botSpawns: BotSpawn[] = [
  { id: "player", name: "You", squadId: "alpha", controller: "human", color: "#ff3b6b", position: { x: 300, y: 920 } },
  { id: "ally-1", name: "Indigo", squadId: "alpha", color: "#2f80ed", position: { x: 380, y: 920 } },
  { id: "ally-2", name: "Sky", squadId: "alpha", color: "#56ccf2", position: { x: 250, y: 890 } },
  { id: "enemy-1", name: "Ochre", squadId: "rival-1", isAmbient: true, color: "#f2994a", position: { x: 2280, y: 690 } },
  { id: "enemy-2", name: "Mint", squadId: "rival-2", isAmbient: true, color: "#27ae60", position: { x: 900, y: 1520 } },
  { id: "enemy-3", name: "Violet", squadId: "rival-3", isAmbient: true, color: "#9b51e0", position: { x: 1620, y: 800 } },
  { id: "enemy-4", name: "Amber", squadId: "rival-4", isAmbient: true, color: "#f2c94c", position: { x: 1100, y: 320 } },
  { id: "enemy-5", name: "Slate", squadId: "rival-5", isAmbient: true, color: "#7f8c8d", position: { x: 500, y: 300 }, floorId: "mercy:F1" },
  { id: "enemy-6", name: "Coal", squadId: "rival-6", isAmbient: true, color: "#4f5b66", position: { x: 480, y: 1240 }, floorId: "lot6:B1" },
  { id: "enemy-7", name: "Coral", squadId: "rival-7", isAmbient: true, color: "#ff7f6e", position: { x: 1810, y: 460 }, floorId: "civic:F4" },
  { id: "enemy-8", name: "Plum", squadId: "rival-8", isAmbient: true, color: "#7d5ba6", position: { x: 1700, y: 430 }, floorId: "civic:F7" },
  { id: "enemy-9", name: "Sage", squadId: "rival-9", isAmbient: true, color: "#6b8f71", position: { x: 1800, y: 1236 }, floorId: "beacon:F1" },
  { id: "enemy-10", name: "Rose", squadId: "rival-10", isAmbient: true, color: "#c75b7a", position: { x: 1750, y: 1120 }, floorId: "beacon:ROOF" },
];

const authoredDowntownMap: MapDocument = {
  id: "downtown",
  name: "Downtown",
  width: MAP_W,
  height: MAP_H,
  // The monochrome lit physical model, indoors and out. `?theme=plan` still
  // renders the old drafting notation for comparison.
  outdoor: outdoorPlan(),
  buildings: [mercyClinic, civicTower, lot6Depot, beaconHouse],
  extractionPoints: [
    { id: "extract-north", name: "NORTH PAD", rect: { x: 900, y: 60, w: 110, h: 110 } },
    // Centred in the depot's east yard (860..1064) rather than straddling the
    // Third Ave footway, which is where it sat before the replan.
    { id: "extract-depot", name: "DEPOT PAD", rect: { x: 910, y: 1150, w: 110, h: 110 } },
    { id: "extract-park", name: "PARK PAD", rect: { x: 2210, y: 1180, w: 110, h: 110 } },
  ],
  insertionPoints: [
    { id: "nw-corner", name: "NW CORNER", position: { x: 110, y: 100 } },
    { id: "ne-park", name: "NE PARK", position: { x: 2140, y: 100 } },
    /**
     * Off the carriageway, now that street furniture is solid.
     *
     * `squadSpawnPosition` spreads three bots 72 units east and south, so a squad
     * needs 120 units of clear depth — exactly a carriageway, with nothing spare,
     * and the kerb strip either side now carries a tree or a lamp every 100 units.
     * Both points moved onto ground that has the room: the clinic's ambulance
     * apron and the tower's car park drive. Arriving on a service yard rather than
     * in a live traffic lane is the better reading anyway.
     */
    { id: "west-gate", name: "WEST APRON", position: { x: 100, y: 560 } },
    { id: "east-gate", name: "EAST LOT", position: { x: 2100, y: 500 } },
    // The depot's east yard. The west alley is 134 wide and a squad needs 120
    // plus clearance, so it only ever fitted there by 14 units.
    { id: "sw-yard", name: "SW YARD", position: { x: 900, y: 1420 } },
    { id: "se-court", name: "SE COURT", position: { x: 2250, y: 1450 } },
  ],
  botSpawns,
};

/** Blueprint dots are inserted before every exported map consumer runs. */
export const downtownMap = addBlueprintSpawns(authoredDowntownMap, 24);

/**
 * Downtown as a REGION, so it can be one place in a larger world.
 *
 * The standalone `downtownMap` above stays exactly as it was — it is the regression map
 * the whole test suite is written against, and it is authored on a 2400 x 1600 sheet
 * with its own edge walls all the way round. `world.ts` needs the same content with a
 * different boundary: the north and west edges are still the edge of the world, but the
 * east and south ones are now internal, with a gate in each where Main St and Third Ave
 * carry on into the yard and the fairground.
 *
 * So the walls are the one thing not exported. Everything else is shared, which means
 * there is no second copy of Downtown to keep in step — the failure mode that a "world
 * version" of a map always has.
 */
export const downtownRegion: RegionParts = {
  id: "downtown",
  name: "Downtown",
  roads,
  surfaces,
  parks: [{ id: "beacon-courtyard", x: 2148, y: 1020, w: 212, h: 400 }],
  objects: outdoorPlan().objects,
  dotSpawns: outdoorPlan().dotSpawns,
  buildings: authoredDowntownMap.buildings,
  extractionPoints: authoredDowntownMap.extractionPoints,
  insertionPoints: authoredDowntownMap.insertionPoints,
  botSpawns,
};

/** The two gates out of the city, and where the world's boundary walls stop for them. */
export const DOWNTOWN_GATES = {
  /** Main St, east into the rail yard: the carriageway and both footways. */
  east: [MAIN_N_BACK, MAIN_S_BACK] as [number, number],
  /** Third Ave, south into the fairground. */
  south: [AVE_W_BACK, AVE_E_BACK] as [number, number],
  width: MAP_W,
  height: MAP_H,
  edge: EDGE,
};
