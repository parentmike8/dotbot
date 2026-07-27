import { compileBuilding, type SourceBuilding, type SourceOpening, type SourceWall } from "../mapSource";

/**
 * Beacon House — residential, SE quadrant of Downtown. Footprint 1560,1020 520x400.
 *
 * GROUND: mail room and kitchen flank the entry lobby; commons in the middle with
 * a WC; laundry occupies the base of the SE shaft. Stair core west.
 * F1: central corridor, three studio apartments and a lounge.
 * ROOF: garden terrace, reached by the east shaft.
 *
 * Migrated from the run helpers in content/downtownLegacy.ts;
 * content/downtownMigration.test.ts holds the proof that nothing moved.
 */

const INT = 8;
const DOOR = 56;
const DOUBLE = 88;

const STAIR_A = { x: 1572, y: 1200, w: 88, h: 160 }; // west core, GROUND↔F1
const STAIR_B = { x: 1980, y: 1248, w: 88, h: 160 }; // east core, F1↔ROOF

function glazing(x: number, y: number, width = 44): SourceOpening {
  return { kind: "window", width, near: { x, y } };
}

/**
 * The west shaft, as one wall: north face, down the east face, back along the
 * south. Both floors share the shaft and only the door moves — GROUND is entered
 * from the commons at the south end, F1 from the corridor at the north.
 */
function westCore(doorY: number): SourceWall {
  return {
    id: "beacon-core-west",
    thickness: INT,
    path: [{ x: 1572, y: 1196 }, { x: 1664, y: 1196 }, { x: 1664, y: 1364 }, { x: 1572, y: 1364 }],
    openings: [{ kind: "door", width: DOOR, near: { x: 1664, y: doorY } }],
  };
}

/** The east shaft: south face of the landing, then down its west face. */
function eastCore(doorY?: number): SourceWall {
  return {
    id: "beacon-core-east",
    thickness: INT,
    path: [{ x: 2068, y: 1244 }, { x: 1976, y: 1244 }, { x: 1976, y: 1408 }],
    openings: doorY === undefined ? [] : [{ kind: "door", width: DOOR, near: { x: 1976, y: doorY } }],
  };
}

export const BEACON_SOURCE: SourceBuilding = {
  id: "beacon",
  kind: "residential",
  name: "BEACON HOUSE",
  shellThickness: 12,
  outline: { shape: "rect", x: 1560, y: 1020, w: 520, h: 400 },
  stairs: [
    { id: "beacon-stair-west", rect: STAIR_A, from: "GROUND", to: "F1", bottom: "S" },
    { id: "beacon-stair-east", rect: STAIR_B, from: "F1", to: "ROOF", bottom: "S" },
  ],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "The building's shared ground: arrive, collect post, cook, sit, do laundry.",
        zones: ["lobby", "mail room", "kitchen", "commons", "WC", "laundry"],
        sequence: "In from Main St into the lobby, post on the left, kitchen on the right, commons straight ahead, stair west.",
        adjacency: "Mail and kitchen flank the entry so both are passed on the way in; laundry hides in the base of the east shaft.",
        negativeSpace: "The middle of the commons stays open — lobby, stair, WC and laundry all connect across it.",
      },
      shellOpenings: [
        { kind: "door", width: DOUBLE, near: { x: 1810, y: 1020 } }, // entrance from Main St
        { kind: "door", width: DOOR, near: { x: 2080, y: 1148 } }, // courtyard door through the kitchen
        glazing(1620, 1020), glazing(1700, 1020), glazing(1920, 1020), glazing(2000, 1020),
        glazing(1560, 1080), glazing(1560, 1140),
        glazing(2080, 1090), glazing(2080, 1150), glazing(2080, 1330),
        glazing(1720, 1420), glazing(1800, 1420),
      ],
      walls: [
        westCore(1316),
        eastCore(1286),
        {
          // Mail room NW: east party wall, then its south wall with the door out.
          id: "beacon-mail",
          thickness: INT,
          path: [{ x: 1764, y: 1032 }, { x: 1764, y: 1196 }, { x: 1572, y: 1196 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1696, y: 1196 } }],
        },
        {
          // Kitchen NE: west party wall, then its south wall with the door out.
          id: "beacon-kitchen",
          thickness: INT,
          path: [{ x: 1856, y: 1032 }, { x: 1856, y: 1196 }, { x: 2068, y: 1196 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1936, y: 1196 } }],
        },
        {
          // Commons WC, tucked against the east shaft.
          id: "beacon-wc",
          thickness: INT,
          path: [{ x: 1976, y: 1324 }, { x: 1892, y: 1324 }, { x: 1892, y: 1408 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1892, y: 1368 } }],
        },
      ],
      objects: [
        // Mail room: lockers and a parcel counter.
        { id: "beacon-mail-locker-a", kind: "locker", x: 1584, y: 1042, w: 26, h: 42 },
        { id: "beacon-mail-locker-b", kind: "locker", x: 1614, y: 1042, w: 26, h: 42 },
        { id: "beacon-mail-locker-c", kind: "locker", x: 1644, y: 1042, w: 26, h: 42, scannable: true },
        { id: "beacon-mail-counter", kind: "counter", x: 1584, y: 1120, w: 22, h: 60 },
        { id: "beacon-parcels", kind: "crateStack", x: 1716, y: 1096, w: 30, h: 30 },
        // Kitchen: worktop run, stove, fridge, breakfast table.
        { id: "beacon-worktop", kind: "counter", x: 1868, y: 1042, w: 140, h: 24 },
        { id: "beacon-kitchen-sink", kind: "sink", x: 1904, y: 1046, w: 26, h: 16 },
        { id: "beacon-stove", kind: "stove", x: 2012, y: 1042, w: 44, h: 26 },
        { id: "beacon-fridge", kind: "fridge", x: 1866, y: 1140, w: 34, h: 46, facing: "E", scannable: true },
        { id: "beacon-breakfast-table", kind: "table", x: 1912, y: 1088, w: 90, h: 52 },
        { id: "beacon-breakfast-chair-w", kind: "chair", x: 1890, y: 1100, w: 20, h: 20, facing: "E" },
        { id: "beacon-breakfast-chair-e", kind: "chair", x: 2004, y: 1100, w: 20, h: 20, facing: "W" },
        // Commons: rug anchors a couch against the south wall; the centre stays
        // open so the lobby, stair, WC and laundry all connect.
        { id: "beacon-commons-rug", kind: "rug", x: 1700, y: 1240, w: 200, h: 140 },
        { id: "beacon-couch", kind: "couch", x: 1720, y: 1360, w: 110, h: 40, facing: "N", scannable: true },
        { id: "beacon-commons-table", kind: "table", x: 1770, y: 1280, w: 48, h: 48 },
        { id: "beacon-commons-chair-w", kind: "chair", x: 1746, y: 1292, w: 20, h: 20, facing: "E" },
        { id: "beacon-commons-chair-e", kind: "chair", x: 1824, y: 1292, w: 20, h: 20, facing: "W" },
        { id: "beacon-commons-plant-w", kind: "plant", x: 1676, y: 1386, w: 20, h: 20 },
        { id: "beacon-commons-plant-e", kind: "plant", x: 2044, y: 1210, w: 20, h: 20 },
        // WC.
        { id: "beacon-wc-pan", kind: "toilet", x: 1938, y: 1368, w: 26, h: 34, facing: "S" },
        { id: "beacon-wc-basin", kind: "sink", x: 1900, y: 1330, w: 22, h: 16 },
        // Laundry (SE shaft base): stacked machines along the east wall.
        { id: "beacon-washer-a", kind: "washer", x: 2016, y: 1260, w: 36, h: 36 },
        { id: "beacon-washer-b", kind: "washer", x: 2016, y: 1304, w: 36, h: 36 },
        { id: "beacon-washer-c", kind: "washer", x: 2016, y: 1348, w: 36, h: 36 },
        { id: "beacon-laundry-sink", kind: "sink", x: 1988, y: 1384, w: 24, h: 16 },
      ],
      dots: [
        { id: "beacon-dot-commons", item: { kind: "powerup", type: "health" }, x: 1786, y: 1240 },
        { id: "beacon-dot-kitchen", item: { kind: "powerup", type: "radar" }, x: 2030, y: 1120 },
      ],
    },
    {
      label: "F1",
      brief: {
        purpose: "Three studios and a shared lounge off one corridor.",
        zones: ["corridor", "NW studio", "NE studio", "SW studio", "lounge"],
        sequence: "Up the west stair into the corridor, apartment doors north, lounge and roof stair south.",
        adjacency: "Each studio has its bath on an outside corner; the lounge sits beside the roof stair.",
        negativeSpace: "The corridor runs the full width and stays clear — it is the only route between the two shafts.",
      },
      shellOpenings: [
        glazing(1700, 1020), glazing(1760, 1020), glazing(1860, 1020), glazing(1930, 1020), glazing(2010, 1020),
        glazing(1560, 1080), glazing(1560, 1140),
        glazing(2080, 1080), glazing(2080, 1140),
        glazing(1730, 1420), glazing(1800, 1420), glazing(1900, 1420),
      ],
      walls: [
        westCore(1236),
        eastCore(1372),
        {
          id: "beacon-corridor-north",
          thickness: INT,
          path: [{ x: 1572, y: 1196 }, { x: 2068, y: 1196 }],
          openings: [
            { kind: "door", width: DOOR, near: { x: 1750, y: 1196 } }, // NW studio
            { kind: "door", width: DOOR, near: { x: 1930, y: 1196 } }, // NE studio
          ],
        },
        {
          id: "beacon-corridor-south",
          thickness: INT,
          path: [{ x: 1668, y: 1276 }, { x: 2068, y: 1276 }],
          openings: [
            { kind: "door", width: DOOR, near: { x: 1756, y: 1276 } }, // SW studio
            { kind: "archway", width: 124, near: { x: 1910, y: 1276 } }, // lounge
          ],
        },
        // Apartment party walls.
        { id: "beacon-party-north", thickness: INT, path: [{ x: 1804, y: 1032 }, { x: 1804, y: 1192 }] },
        { id: "beacon-party-south", thickness: INT, path: [{ x: 1844, y: 1280 }, { x: 1844, y: 1408 }] },
        { id: "beacon-lounge-return", thickness: INT, path: [{ x: 1664, y: 1368 }, { x: 1664, y: 1408 }] },
        {
          id: "beacon-bath-nw",
          thickness: INT,
          path: [{ x: 1660, y: 1044 }, { x: 1660, y: 1112 }, { x: 1572, y: 1112 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1624, y: 1112 } }],
        },
        {
          id: "beacon-bath-ne",
          thickness: INT,
          path: [{ x: 1980, y: 1044 }, { x: 1980, y: 1112 }, { x: 2068, y: 1112 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 2016, y: 1112 } }],
        },
        {
          id: "beacon-bath-sw",
          thickness: INT,
          path: [{ x: 1668, y: 1336 }, { x: 1756, y: 1336 }, { x: 1756, y: 1408 }],
          openings: [{ kind: "door", width: DOOR, near: { x: 1722, y: 1336 } }],
        },
      ],
      objects: [
        // NW studio: bath NW, bed beside it, kitchenette east wall. The strip
        // south of the bed stays clear — it links the bath to the front door.
        { id: "beacon-nw-bed", kind: "bed", x: 1672, y: 1044, w: 48, h: 92, facing: "N", scannable: true },
        { id: "beacon-nw-cabinet", kind: "cabinet", x: 1730, y: 1044, w: 44, h: 24 },
        { id: "beacon-nw-counter", kind: "counter", x: 1776, y: 1076, w: 22, h: 48 },
        { id: "beacon-nw-chair", kind: "chair", x: 1620, y: 1150, w: 20, h: 20, facing: "E" },
        { id: "beacon-nw-rug", kind: "rug", x: 1596, y: 1128, w: 56, h: 56 },
        { id: "beacon-nw-wc", kind: "toilet", x: 1590, y: 1052, w: 26, h: 34, facing: "N" },
        { id: "beacon-nw-basin", kind: "sink", x: 1624, y: 1050, w: 22, h: 16 },
        // NE studio: mirrored bath, bed west, dining centre.
        { id: "beacon-ne-bed", kind: "bed", x: 1830, y: 1044, w: 48, h: 92, facing: "N" },
        { id: "beacon-ne-cabinet", kind: "cabinet", x: 1890, y: 1044, w: 44, h: 24 },
        { id: "beacon-ne-table", kind: "table", x: 1888, y: 1096, w: 44, h: 44 },
        { id: "beacon-ne-chair", kind: "chair", x: 1866, y: 1106, w: 20, h: 20, facing: "E" },
        { id: "beacon-ne-fridge", kind: "fridge", x: 1816, y: 1156, w: 30, h: 32, facing: "N" },
        { id: "beacon-ne-wc", kind: "toilet", x: 2020, y: 1052, w: 26, h: 34, facing: "N" },
        { id: "beacon-ne-basin", kind: "sink", x: 1990, y: 1050, w: 22, h: 16 },
        // SW studio: bath SW, bed east.
        { id: "beacon-sw-bed", kind: "bed", x: 1790, y: 1300, w: 48, h: 88, facing: "S", scannable: true },
        { id: "beacon-sw-rug", kind: "rug", x: 1694, y: 1288, w: 80, h: 40 },
        { id: "beacon-sw-chair", kind: "chair", x: 1700, y: 1296, w: 20, h: 20, facing: "E" },
        { id: "beacon-sw-wc", kind: "toilet", x: 1690, y: 1356, w: 26, h: 34, facing: "S" },
        { id: "beacon-sw-basin", kind: "sink", x: 1722, y: 1378, w: 22, h: 16 },
        // Lounge: reading corner by the south windows; centre left open so the
        // roof stair door stays approachable.
        /**
         * The lounge holds a couch and a plant, and that is all it can hold.
         *
         * It is 124 x 128 inside, which leaves a 76 x 80 box for a bot centre once
         * the radius is taken off. It has to serve two openings — the 124-wide
         * archway on its north side and the roof-stair door in its east wall at
         * y 1344..1400 — so the route between them is the room's whole job.
         *
         * A 60-unit shelf broke that twice. At 1900,1382 it sat 16 units off the
         * core wall beside the stair door: passing the door needs a bot centred at
         * y 1368..1376 to clear the jambs and y <= 1364 to clear the shelf, so the
         * roof was simply unreachable. Moved to the north edge it sealed the
         * archway instead, because the couch already blocks everything west of
         * x 1920 and the shelf covered the rest. The couch is 20 units shorter for
         * the same reason: it has to leave a clear channel down the east side.
         */
        { id: "beacon-lounge-couch", kind: "couch", x: 1856, y: 1300, w: 40, h: 70, facing: "E" },
        { id: "beacon-lounge-plant", kind: "plant", x: 1858, y: 1382, w: 18, h: 18 },
      ],
      dots: [
        { id: "beacon-dot-lounge", item: { kind: "powerup", type: "health" }, x: 1930, y: 1236 },
        { id: "beacon-dot-corridor", item: { kind: "powerup", type: "dashOvercharge" }, x: 1730, y: 1236 },
      ],
    },
    {
      label: "ROOF",
      brief: {
        purpose: "A garden terrace the residents share, and the building's plant.",
        zones: ["garden beds", "potting bench", "social corner", "service corner"],
        sequence: "Up the east shaft, out onto the terrace, west along the beds.",
        adjacency: "Plant sits NE, away from the seating; the beds take the sunny west edge.",
        negativeSpace: "The middle of the terrace stays open, so the whole roof reads as one place to be.",
      },
      walls: [eastCore(1284)],
      objects: [
        // Garden beds west.
        { id: "beacon-bed-nw", kind: "planter", x: 1596, y: 1060, w: 36, h: 110 },
        { id: "beacon-bed-ne", kind: "planter", x: 1676, y: 1060, w: 36, h: 110 },
        { id: "beacon-bed-sw", kind: "planter", x: 1596, y: 1210, w: 36, h: 110 },
        { id: "beacon-bed-se", kind: "planter", x: 1676, y: 1210, w: 36, h: 110 },
        // Potting bench and social corner.
        { id: "beacon-potting", kind: "workbench", x: 1600, y: 1360, w: 110, h: 30, facing: "N", scannable: true },
        { id: "beacon-terrace-bench", kind: "bench", x: 1770, y: 1080, w: 100, h: 22, facing: "S" },
        { id: "beacon-terrace-table", kind: "table", x: 1800, y: 1250, w: 48, h: 48 },
        { id: "beacon-terrace-chair-w", kind: "chair", x: 1782, y: 1262, w: 20, h: 20, facing: "E" },
        { id: "beacon-terrace-chair-e", kind: "chair", x: 1852, y: 1262, w: 20, h: 20, facing: "W" },
        { id: "beacon-terrace-plant", kind: "plant", x: 1760, y: 1180, w: 24, h: 24 },
        // Service corner NE.
        { id: "beacon-roof-hvac", kind: "hvac", x: 1920, y: 1080, w: 70, h: 50 },
        { id: "beacon-roof-vent", kind: "vent", x: 2010, y: 1090, w: 22, h: 22 },
        { id: "beacon-roof-skylight", kind: "skylight", x: 1780, y: 1160, w: 90, h: 56 },
        { id: "beacon-roof-power", kind: "utilityBox", x: 1930, y: 1160, w: 26, h: 20 },
      ],
      dots: [
        { id: "beacon-dot-garden", item: { kind: "powerup", type: "incognito" }, x: 1744, y: 1136 },
        { id: "beacon-dot-terrace", item: { kind: "powerup", type: "health" }, x: 1890, y: 1320 },
      ],
    },
  ],
};

export const beaconHouse = compileBuilding(BEACON_SOURCE);
