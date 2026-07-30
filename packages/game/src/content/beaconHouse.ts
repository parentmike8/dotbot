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
        // South to 1144, which opens a 36-unit band below the locker run. At 1120 the run
        // was boxed between the north wall, its own neighbours and this counter, so locker A
        // — the only one of the three with a wall on its far side — could not be reached.
        { id: "beacon-mail-counter", kind: "counter", x: 1584, y: 1144, w: 22, h: 48 },
        { id: "beacon-parcels", kind: "crateStack", x: 1716, y: 1096, w: 30, h: 30 },
        // Kitchen: worktop run, stove, fridge, breakfast table.
        /**
         * A galley along the north wall, and no breakfast table, because the arithmetic says
         * the room cannot have both.
         *
         * The kitchen is 208 x 160 with its door in the south wall at x 1908–1964. A 24-deep
         * worktop needs 64 of clear floor below it before the next run — that is the
         * false-aisle rule and it was reporting this pair at 22 — and the door needs a body's
         * diameter of approach north of it. 24 + 64 + 52 + 48 is 188 units of requirement in
         * 160 units of room. The table lost, and nothing about it was reachable anyway: the
         * worktop, the sink and the stove were all fixtures no bot could stand beside, because
         * the table sat 22 units off the whole run.
         *
         * The commons through that door already has a dining table forty units away. Two
         * eating places in one shared house, forty units apart, was the real redundancy.
         */
        { id: "beacon-worktop", kind: "counter", x: 1868, y: 1042, w: 140, h: 24 },
        { id: "beacon-kitchen-sink", kind: "sink", x: 1904, y: 1046, w: 26, h: 16 },
        { id: "beacon-stove", kind: "stove", x: 2012, y: 1042, w: 44, h: 26 },
        { id: "beacon-fridge", kind: "fridge", x: 1866, y: 1140, w: 34, h: 46, facing: "E", scannable: true },
        // Commons: rug anchors a couch against the south wall; the centre stays
        // open so the lobby, stair, WC and laundry all connect.
        { id: "beacon-commons-rug", kind: "rug", x: 1700, y: 1240, w: 200, h: 140 },
        { id: "beacon-couch", kind: "couch", x: 1720, y: 1360, w: 110, h: 40, facing: "N", scannable: true },
        /**
         * The dining cluster sits 26 units further up the rug than it did.
         *
         * Couch to table was 32 units — a third of it floor a bot cannot enter — and
         * that was survivable only while the placer could fall back to somewhere a
         * chair now stands. At 1254 the gap is 58, so the couch has an approach on its
         * own north side, which is where you would walk to it anyway.
         */
        /**
         * 44 wide rather than 48, which is the whole fix.
         *
         * The couch and this table faced each other across 58 units — a gap a bot fits through
         * with five units to spare, which is what the false-aisle band is for. Opening it to 64
         * would push the table into the stair's approach and closing it to 16 would put a
         * dining table in a couch. But the rule only fires when two fixtures overlap by a
         * bot's DIAMETER along the other axis, and a 48-wide table inside a 110-wide couch
         * overlaps by exactly 48. Four units narrower and they are no longer a facing pair —
         * which is true, because you walk round this table, not between it and the couch.
         */
        { id: "beacon-commons-table", kind: "table", x: 1772, y: 1254, w: 44, h: 48 },
        { id: "beacon-commons-chair-w", kind: "chair", x: 1748, y: 1266, w: 20, h: 20, facing: "E" },
        { id: "beacon-commons-chair-e", kind: "chair", x: 1820, y: 1266, w: 20, h: 20, facing: "W" },
        { id: "beacon-commons-plant-w", kind: "plant", x: 1676, y: 1386, w: 20, h: 20 },
        // The east pot is gone. It stood in the 44-unit band between the kitchen's south wall
        // and the east shaft's north face — too shallow for a body, so nobody could ever have
        // been near it. `beacon-commons-plant-w` keeps the commons its greenery.
        // WC.
        { id: "beacon-wc-pan", kind: "toilet", x: 1938, y: 1368, w: 26, h: 34, facing: "S" },
        // East of the door threshold (reaches x=1906) rather than across it, and west of
        // the pan at 1938. Moving it north instead would have put it in the wall.
        { id: "beacon-wc-basin", kind: "sink", x: 1910, y: 1330, w: 22, h: 16 },
        // Laundry (SE shaft base): stacked machines along the east wall.
        /**
         * Flush to the east wall, not floating 16 units off it.
         *
         * The laundry is 92 wide between its own walls and a washer is 36 deep, so
         * standing the row at 2016 left a 40-unit band to walk down — and a bot is 48
         * across. The room's own doorway was sealed: `beacon-core-east-d0` measured
         * 26.08 units to the nearest ground a bot could stand on, against a limit of
         * 24. Invisible until washers became colliders, which is the entire argument
         * for making them colliders.
         */
        { id: "beacon-washer-a", kind: "washer", x: 2032, y: 1260, w: 36, h: 36 },
        { id: "beacon-washer-b", kind: "washer", x: 2032, y: 1304, w: 36, h: 36 },
        { id: "beacon-washer-c", kind: "washer", x: 2032, y: 1348, w: 36, h: 36 },
        { id: "beacon-laundry-sink", kind: "sink", x: 1988, y: 1384, w: 24, h: 16 },
      ],
      dots: [
        // North of the dining cluster, not under it, and out of the breakfast chair.
        // Both sat inside a chair or table footprint, which only worked while those
        // were walk-through.
        { id: "beacon-dot-commons", item: { kind: "powerup", type: "health" }, x: 1810, y: 1196 },
        { id: "beacon-dot-kitchen", item: { kind: "powerup", type: "radar" }, x: 2036, y: 1164 },
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
        /**
         * Four units of clearance each, so the bed beside them has an approach.
         *
         * The bed's east point is the only one of its four that is not a wall, and it
         * sat 22 units off both of these — two short of a bot on each side. While a
         * chair was walk-through the placer could fall back to a strip of floor in the
         * studio next door, which was the wrong room for this bed's blueprint anyway;
         * once chairs collided that strip closed and the map stopped building. A
         * shallower cabinet and a counter two units further out fix the cause rather
         * than the fallback.
         */
        { id: "beacon-nw-cabinet", kind: "cabinet", x: 1730, y: 1044, w: 44, h: 20 },
        /**
         * Down the party wall SOUTH of the bed, not level with it.
         *
         * At 1780 x 22 this kitchenette ran to 1802 and the party wall's capsule covers
         * 1800–1808, so a fifth of the counter stood inside the masonry between two flats.
         * Pulling it clear leaves 56 units to the bed — inside the false-aisle band — and 64
         * is not available, because 64 puts it back in the wall.
         *
         * Shortening it instead cleared the rule and broke something better hidden: the map
         * stopped compiling with "No bot-clear blueprint spawn for beacon/beacon:F1/bed",
         * because the bed's east flank is the only one of its four sides that is not a wall
         * and the counter is what decides how much of it is open. So the counter goes past the
         * bed's foot instead, where it faces nothing and leaves the whole east flank clear.
         * A worktop down the wall from the bed is also just where a studio puts one.
         *
         * At y=1140 that meant standing in the flat's own front door, whose span reaches
         * x=1778 — two units past the counter's west edge. Third position, and this one is
         * clear of the bed's overlap band, clear of the party wall and clear of the threshold.
         */
        { id: "beacon-nw-counter", kind: "counter", x: 1778, y: 1092, w: 22, h: 48 },
        // Down the rug, clear of the bathroom door's south approach at 1624,1136.
        { id: "beacon-nw-chair", kind: "chair", x: 1620, y: 1164, w: 20, h: 20, facing: "E" },
        { id: "beacon-nw-rug", kind: "rug", x: 1596, y: 1128, w: 56, h: 56 },
        /**
         * Fixtures hug one wall, because the room is 88 across and a bot is 48.
         *
         * Split across both walls — pan on one side, basin on the other — they left a
         * 40-unit channel and sealed the bathroom's own door: `beacon-bath-*-d0`
         * measured 26.9 and 31.6 units to the nearest standable ground against a limit
         * of 24. Passable fixtures hid it, which is the argument for the promotion, and
         * a real bathroom puts its fixtures on one wall anyway.
         */
        { id: "beacon-nw-wc", kind: "toilet", x: 1580, y: 1048, w: 26, h: 34, facing: "N" },
        // Clear of the bath door's gap, which starts at 1596. Hugging the wall to open the
        // room put this one in its own threshold — caught by the doorway sweep, not by eye.
        { id: "beacon-nw-basin", kind: "sink", x: 1572, y: 1088, w: 22, h: 16 },
        // NE studio: mirrored bath, bed west, dining centre.
        { id: "beacon-ne-bed", kind: "bed", x: 1830, y: 1044, w: 48, h: 92, facing: "N" },
        // The NE studio's wall cabinet is gone. It was boxed by the bed to the west, the
        // table 28 units south and the bathroom wall 42 east — a 160-deep studio holding a
        // 92-deep bed has no room for another north-wall run, and this one could only be
        // looked at. The flat keeps its bed, table, chair, fridge and bathroom.
        { id: "beacon-ne-table", kind: "table", x: 1888, y: 1096, w: 44, h: 44 },
        /**
         * On the far side of its own dining table, flush to it.
         *
         * It began twelve units under the bed, which is an overlap the moment a chair
         * collides. East of the bed is no good either: bed and table leave a 10-unit
         * slot and the chair is 20 wide, so it just swapped one overlap for another.
         * The table's east face is open floor for eighty units.
         */
        { id: "beacon-ne-chair", kind: "chair", x: 1932, y: 1108, w: 20, h: 20, facing: "W" },
        { id: "beacon-ne-fridge", kind: "fridge", x: 1816, y: 1156, w: 30, h: 32, facing: "N" },
        // Mirrored, and on the east wall for the same reason.
        { id: "beacon-ne-wc", kind: "toilet", x: 2034, y: 1048, w: 26, h: 34, facing: "N" },
        { id: "beacon-ne-basin", kind: "sink", x: 2046, y: 1088, w: 22, h: 16 },
        // SW studio: bath SW, bed east.
        { id: "beacon-sw-bed", kind: "bed", x: 1790, y: 1300, w: 48, h: 88, facing: "S", scannable: true },
        { id: "beacon-sw-rug", kind: "rug", x: 1694, y: 1288, w: 80, h: 40 },
        { id: "beacon-sw-chair", kind: "chair", x: 1700, y: 1296, w: 20, h: 20, facing: "E" },
        // West wall, clearing the door on the room's north side.
        { id: "beacon-sw-wc", kind: "toilet", x: 1668, y: 1344, w: 26, h: 34, facing: "S" },
        { id: "beacon-sw-basin", kind: "sink", x: 1672, y: 1384, w: 22, h: 16 },
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
        // East of the couch rather than in the 12-unit gap under it.
        { id: "beacon-lounge-plant", kind: "plant", x: 1912, y: 1382, w: 18, h: 18 },
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
        /**
         * 64 units between the beds, not 44.
         *
         * Four raised beds with a 44-unit gap down the middle is a path you can see and not
         * walk — the false-aisle band exactly, reported twice, and the three standable slivers
         * the probe found stranded on this terrace were all inside it.
         *
         * Widening it to 64 was the wrong repair and the probe said so immediately: a 64-unit
         * gap between beds 110 long, closed at both ends by the parapet standoff, is a 24-wide
         * dead-end corridor — 4,992 square units of terrace you can stand in and never reach.
         * So each pair JOINS into one double-width bed with an 8-unit seam, and the path is the
         * open deck east of them, where it was all along.
         *
         * And each pair is ONE object, not two with a seam. Two 36-wide planters touching are
         * one raised bed to look at and two rects to the probe, which duly reported that
         * nobody could stand beside the inner one — true of the rect and meaningless about
         * the bed. The contract's rule is that the silhouette is the footprint is the
         * collider; a joined pair breaks it in the only direction that matters here, by
         * describing one thing as two. Two beds, 64 units of path between them.
         */
        { id: "beacon-bed-n", kind: "planter", x: 1596, y: 1060, w: 80, h: 110 },
        { id: "beacon-bed-s", kind: "planter", x: 1596, y: 1234, w: 80, h: 110 },
        // Potting bench and social corner.
        { id: "beacon-potting", kind: "workbench", x: 1600, y: 1360, w: 110, h: 30, facing: "N", scannable: true },
        { id: "beacon-terrace-bench", kind: "bench", x: 1770, y: 1080, w: 100, h: 22, facing: "S" },
        { id: "beacon-terrace-table", kind: "table", x: 1800, y: 1250, w: 48, h: 48 },
        // Two units west, so it touches the terrace table instead of overlapping it.
        { id: "beacon-terrace-chair-w", kind: "chair", x: 1780, y: 1262, w: 20, h: 20, facing: "E" },
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
