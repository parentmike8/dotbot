import { OUTDOOR_FLOOR_ID } from "../types";
import type {
  BotSpawn,
  Building,
  Doorway,
  DotSpawn,
  FloorPlan,
  MapDocument,
  MapObject,
  StairLink,
  WallSegment,
  WindowBand,
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
 * Main St runs east-west, Third Ave north-south, and a service lane crosses
 * the south blocks. Three extraction pads: north plaza, depot yard, courtyard.
 *
 * Authoring rules learned the hard way:
 *  - every object earns its place; no filler rows, no scattered clutter;
 *  - circulation lanes stay open — validation flood-fills every floor;
 *  - windows are composed per facade, never sprayed;
 *  - repetition is reserved for things that truly repeat (racks, ward bays).
 */

const MAP_W = 2400;
const MAP_H = 1600;
const EDGE = 26;
const EXT = 12; // exterior wall thickness
const INT = 8; // interior partition thickness
const DOOR = 56; // single leaf
const DOUBLE = 88; // paired leaf
const ROLLUP = 120; // vehicle door

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

type DoorSpec = { at: number; w: number; open?: boolean };

type RunResult = { walls: WallSegment[]; doorways: Doorway[] };

let wallSeq = 0;
let doorSeq = 0;
let winSeq = 0;
let objSeq = 0;
let dotSeq = 0;

function segments(length: number, doors: DoorSpec[]): Array<{ start: number; size: number }> {
  const sorted = doors
    .map((door) => ({ start: Math.max(0, door.at), end: Math.min(length, door.at + door.w) }))
    .filter((door) => door.end > door.start)
    .sort((a, b) => a.start - b.start);
  const spans: Array<{ start: number; size: number }> = [];
  let cursor = 0;

  for (const door of sorted) {
    if (door.start > cursor) {
      spans.push({ start: cursor, size: door.start - cursor });
    }

    cursor = Math.max(cursor, door.end);
  }

  if (cursor < length) {
    spans.push({ start: cursor, size: length - cursor });
  }

  return spans;
}

function hRun(x: number, y: number, len: number, t: number, doors: DoorSpec[] = []): RunResult {
  const walls = segments(len, doors).map((seg) => ({
    id: `w${wallSeq++}`,
    x: x + seg.start,
    y,
    w: seg.size,
    h: t,
  }));
  const doorways = doors.map((door) => ({
    id: `d${doorSeq++}`,
    x: x + door.at + door.w / 2,
    y: y + t / 2,
    width: door.w,
    dir: "h" as const,
    open: door.open,
  }));

  return { walls, doorways };
}

function vRun(x: number, y: number, len: number, t: number, doors: DoorSpec[] = []): RunResult {
  const walls = segments(len, doors).map((seg) => ({
    id: `w${wallSeq++}`,
    x,
    y: y + seg.start,
    w: t,
    h: seg.size,
  }));
  const doorways = doors.map((door) => ({
    id: `d${doorSeq++}`,
    x: x + t / 2,
    y: y + door.at + door.w / 2,
    width: door.w,
    dir: "v" as const,
    open: door.open,
  }));

  return { walls, doorways };
}

type PerimeterDoors = Partial<Record<"top" | "bottom" | "left" | "right", DoorSpec[]>>;

function perimeter(fp: { x: number; y: number; w: number; h: number }, doors: PerimeterDoors = {}): RunResult {
  const runs = [
    hRun(fp.x, fp.y, fp.w, EXT, doors.top ?? []),
    hRun(fp.x, fp.y + fp.h - EXT, fp.w, EXT, doors.bottom ?? []),
    vRun(fp.x, fp.y + EXT, fp.h - EXT * 2, EXT, offsetDoors(doors.left ?? [], -EXT)),
    vRun(fp.x + fp.w - EXT, fp.y + EXT, fp.h - EXT * 2, EXT, offsetDoors(doors.right ?? [], -EXT)),
  ];
  // Side runs start EXT below the footprint top; door offsets are authored
  // relative to the footprint edge, so shift them into run space above.
  return mergeRuns(runs);
}

function offsetDoors(doors: DoorSpec[], delta: number): DoorSpec[] {
  return doors.map((door) => ({ ...door, at: door.at + delta }));
}

function mergeRuns(runs: RunResult[]): RunResult {
  return {
    walls: runs.flatMap((run) => run.walls),
    doorways: runs.flatMap((run) => run.doorways),
  };
}

function obj(kind: MapObject["kind"], x: number, y: number, w: number, h: number, extra: Partial<MapObject> = {}): MapObject {
  return { id: `o${objSeq++}`, kind, x, y, w, h, ...extra };
}

function tree(cx: number, cy: number, r = 24): MapObject {
  return obj("tree", cx - r, cy - r, r * 2, r * 2);
}

/** Horizontal window band centered at cx in the wall crossing (cx, y). */
function winH(cx: number, y: number, len = 44): WindowBand {
  return { id: `win${winSeq++}`, x: cx, y, length: len, dir: "h" };
}

/** Vertical window band centered at cy in the wall crossing (x, cy). */
function winV(x: number, cy: number, len = 44): WindowBand {
  return { id: `win${winSeq++}`, x, y: cy, length: len, dir: "v" };
}

function dot(color: string, x: number, y: number): DotSpawn {
  return { id: `dot-${dotSeq++}`, color, position: { x, y } };
}

// Dot palette: color implies type later; for now it is identity only.
const DOT = {
  regen: "#27ae60",
  shield: "#2f80ed",
  dash: "#56ccf2",
  scanner: "#f2c94c",
  decoy: "#f2994a",
  damage: "#eb5757",
  rare: "#9b51e0",
};

// ---------------------------------------------------------------------------
// Mercy Clinic — hospital, NW quadrant. Footprint 200,140 620x440.
//
// Parti: a north band of four clinical rooms (exam, exam, imaging, pharmacy)
// served by an east-west corridor; the south half is an open waiting hall
// with reception, the stair core, and a staff room with WC on the east.
// Ambulance door west into the corridor, main entrance south, staff door east.
// ---------------------------------------------------------------------------

function mercyClinic(): Building {
  const fp = { x: 200, y: 140, w: 620, h: 440 };

  const groundShell = perimeter(fp, {
    bottom: [{ at: 216, w: DOUBLE }], // main entrance from Main St
    left: [{ at: 188, w: DOOR }], // ambulance door into the corridor
    right: [{ at: 360, w: DOOR }], // staff entrance
  });
  const groundPartitions = mergeRuns([
    // Clinical band: south wall with a door per room.
    hRun(212, 320, 596, INT, [
      { at: 88, w: DOOR }, // exam 1
      { at: 220, w: DOOR }, // exam 2
      { at: 360, w: DOOR }, // imaging
      { at: 500, w: DOOR }, // pharmacy
    ]),
    // Partitions between the four rooms.
    vRun(372, 152, 168, INT),
    vRun(532, 152, 168, INT),
    vRun(672, 152, 168, INT),
    // Stair core east: corridor wall above, staff band below.
    hRun(596, 392, 212, INT),
    hRun(596, 480, 212, INT),
    // Staff WC (entered from the hall) and staff room (exterior door only).
    vRun(596, 488, 80, INT, [{ at: 12, w: DOOR }]),
    vRun(716, 488, 80, INT),
  ]);

  const ground: FloorPlan = {
    id: "mercy:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    windows: [
      // South: waiting hall daylight, either side of the entrance.
      winH(280, 568),
      winH(360, 568),
      winH(560, 568),
      // West: exam room and waiting hall.
      winV(200, 220),
      winV(200, 280),
      winV(200, 460),
      winV(200, 524),
      // North: one per clinical room.
      winH(290, 140),
      winH(450, 140),
      winH(600, 140),
      winH(742, 140),
      // East: pharmacy.
      winV(808, 200),
      winV(808, 262),
    ],
    objects: [
      // Exam 1 (NW): table, worktop, stool.
      obj("bed", 232, 162, 48, 88, { facing: "N", scannable: true }),
      obj("cabinet", 216, 268, 34, 22),
      obj("sink", 320, 158, 26, 18),
      obj("chair", 322, 262, 20, 20, { facing: "W" }),
      // Exam 2.
      obj("bed", 396, 162, 48, 88, { facing: "N" }),
      obj("cabinet", 384, 268, 34, 22),
      obj("sink", 484, 158, 26, 18),
      obj("chair", 486, 262, 20, 20, { facing: "W" }),
      // Imaging: scanner table and console.
      obj("cot", 566, 170, 44, 84, { facing: "N", scannable: true }),
      obj("serverRack", 632, 154, 26, 56),
      obj("utilityBox", 632, 220, 26, 20),
      // Pharmacy: shelving runs and dispensing worktop.
      obj("shelf", 688, 168, 24, 108, { scannable: true }),
      obj("shelf", 770, 168, 24, 108),
      obj("counter", 782, 286, 24, 26),
      obj("fridge", 682, 286, 30, 30, { facing: "E" }),
      // Corridor: one crash cart, nothing else — it is a lane.
      obj("medicalCart", 770, 332, 30, 22),
      // Waiting hall: reception faces the entrance; two chair rows west.
      obj("receptionDesk", 360, 420, 140, 26, { facing: "S", scannable: true }),
      obj("chair", 240, 480, 22, 22, { facing: "S" }),
      obj("chair", 286, 480, 22, 22, { facing: "S" }),
      obj("chair", 332, 480, 22, 22, { facing: "S" }),
      obj("chair", 240, 520, 22, 22, { facing: "N" }),
      obj("chair", 286, 520, 22, 22, { facing: "N" }),
      obj("chair", 332, 520, 22, 22, { facing: "N" }),
      obj("table", 232, 424, 44, 32),
      obj("plant", 218, 544, 20, 20),
      obj("plant", 566, 540, 20, 20),
      // Staff WC (west room) and staff room (east room).
      obj("toilet", 664, 530, 26, 34, { facing: "S" }),
      obj("sink", 610, 494, 24, 16),
      obj("locker", 728, 490, 26, 38, { scannable: true }),
      obj("locker", 728, 532, 26, 36),
      obj("plant", 790, 548, 18, 18),
    ],
    stairs: [
      {
        id: "mercy-stair-up",
        rect: { x: 604, y: 400, w: 196, h: 80 },
        direction: "up",
        toFloorId: "mercy:F1",
        bottom: "W",
      },
    ],
    dotSpawns: [dot(DOT.regen, 470, 208), dot(DOT.shield, 742, 226)],
  };

  const f1Shell = perimeter(fp);
  const f1Partitions = mergeRuns([
    // Ward bays: privacy partitions off the north wall.
    vRun(350, 152, 120, INT),
    vRun(470, 152, 120, INT),
    vRun(590, 152, 120, INT),
    // Stair core (same shaft as GROUND), entered from the lounge south of it.
    hRun(596, 392, 212, INT),
    hRun(596, 480, 212, INT, [{ at: 144, w: DOOR }]),
    // Supply room SW and staff WC beside it.
    hRun(212, 430, 168, INT, [{ at: 110, w: DOOR }]),
    vRun(380, 430, 138, INT),
    hRun(388, 488, 80, INT),
    vRun(468, 488, 80, INT, [{ at: 14, w: DOOR }]),
  ]);

  const f1: FloorPlan = {
    id: "mercy:F1",
    label: "F1",
    walls: [...f1Shell.walls, ...f1Partitions.walls],
    doorways: [...f1Shell.doorways, ...f1Partitions.doorways],
    windows: [
      winH(280, 568),
      winH(340, 568),
      winH(520, 568),
      winV(200, 210),
      winV(200, 280),
      winV(200, 360),
      winV(200, 500),
      winH(290, 140),
      winH(430, 140),
      winH(550, 140),
      winH(700, 140),
      winV(808, 200),
      winV(808, 270),
      winV(808, 528),
    ],
    objects: [
      // Recovery ward: four bays, each bed + bedside unit; IV poles between.
      obj("bed", 268, 162, 48, 92, { facing: "N", scannable: true }),
      obj("bed", 388, 162, 48, 92, { facing: "N" }),
      obj("bed", 508, 162, 48, 92, { facing: "N" }),
      obj("bed", 628, 162, 48, 92, { facing: "N" }),
      obj("medicalCabinet", 230, 166, 26, 20),
      obj("medicalCabinet", 444, 166, 26, 20),
      obj("medicalCabinet", 564, 166, 26, 20),
      obj("medicalCabinet", 684, 166, 26, 20),
      obj("ivStand", 328, 190, 16, 16),
      obj("ivStand", 690, 200, 16, 16),
      // Nurse station: counter facing the ward, desk tucked behind. Kept
      // narrow so the lanes on both sides of the station stay walkable.
      obj("counter", 420, 380, 110, 24, { scannable: true }),
      obj("desk", 430, 414, 72, 44, { facing: "S" }),
      obj("medicalCart", 566, 388, 30, 22),
      // Supply room SW.
      obj("shelf", 222, 442, 24, 110),
      obj("shelf", 262, 540, 90, 24),
      obj("crateStack", 300, 528, 34, 34),
      // Staff WC.
      obj("toilet", 398, 532, 26, 34, { facing: "S" }),
      obj("sink", 396, 496, 24, 16),
      // Lounge SE below the stair: soft corner, no solid blockers — this is
      // the only route between the stair door and the open floor.
      obj("rug", 640, 502, 110, 58),
      obj("chair", 656, 516, 22, 22, { facing: "E" }),
      obj("chair", 712, 516, 22, 22, { facing: "W" }),
      obj("plant", 780, 544, 20, 20),
    ],
    stairs: [
      {
        id: "mercy-stair-down",
        rect: { x: 604, y: 400, w: 196, h: 80 },
        direction: "down",
        toFloorId: OUTDOOR_FLOOR_ID,
        bottom: "W",
      },
    ],
    dotSpawns: [dot(DOT.regen, 330, 300), dot(DOT.regen, 570, 300), dot(DOT.rare, 300, 500)],
  };

  return {
    id: "mercy",
    kind: "hospital",
    name: "MERCY CLINIC",
    footprint: fp,
    floors: [ground, f1],
  };
}

// ---------------------------------------------------------------------------
// Civic Tower — office, NE quadrant. Footprint 1480,120 560x420.
//
// Eight occupied floors plus a walkable roof. Two scissor-stair shafts sit on
// the north wall with a WC stack between them, so climbing the tower means
// crossing every floor. A pair of structural columns marks the open plan.
// ---------------------------------------------------------------------------

function civicTower(): Building {
  const fp = { x: 1480, y: 120, w: 560, h: 420 };

  // Shaft A (NW) and shaft B (NE); doors sit at the entry end of each run.
  const STAIR_A = { x: 1492, y: 132, w: 88, h: 160 };
  const STAIR_B = { x: 1940, y: 132, w: 88, h: 160 };
  const UP_DOOR = 104; // south half of the run
  const DOWN_DOOR = 8; // north half

  const coreA = (doorAt: number): RunResult =>
    mergeRuns([vRun(1580, 132, 160, INT, [{ at: doorAt, w: DOOR }]), hRun(1492, 292, 96, INT)]);
  const coreB = (doorAt: number): RunResult =>
    mergeRuns([vRun(1932, 132, 160, INT, [{ at: doorAt, w: DOOR }]), hRun(1932, 292, 96, INT)]);
  // WC stack between the shafts: two rooms entered from the south.
  const wcBlock = (): RunResult =>
    mergeRuns([
      vRun(1700, 132, 120, INT),
      vRun(1780, 132, 120, INT),
      vRun(1860, 132, 120, INT),
      hRun(1700, 252, 168, INT, [
        { at: 24, w: DOOR },
        { at: 104, w: DOOR },
      ]),
    ]);
  const wcFixtures = (): MapObject[] => [
    obj("toilet", 1712, 140, 26, 34, { facing: "N" }),
    obj("sink", 1744, 142, 22, 16),
    obj("toilet", 1822, 140, 26, 34, { facing: "N" }),
    obj("sink", 1794, 142, 22, 16),
  ];
  // Facade glazing shared by the upper floors.
  const upperWindows = (): WindowBand[] => [
    winV(1480, 190),
    winV(1480, 250),
    winV(1480, 340),
    winV(1480, 420),
    winV(1480, 480),
    winH(1620, 120),
    winH(1680, 120),
    winH(1900, 120),
    winH(1550, 528),
    winH(1630, 528),
    winH(1710, 528),
    winH(1790, 528),
    winH(1870, 528),
    winH(1950, 528),
    winV(2028, 180),
    winV(2028, 240),
    winV(2028, 320),
    winV(2028, 400),
    winV(2028, 480),
  ];

  const groundShell = perimeter(fp, {
    left: [{ at: 176, w: DOUBLE }], // main entrance from Third Ave
    bottom: [{ at: 272, w: DOOR }], // side exit to Main St
  });
  const groundPartitions = mergeRuns([
    coreA(UP_DOOR),
    wcBlock(),
    // Mail room SE.
    vRun(1880, 400, 128, INT, [{ at: 36, w: DOOR }]),
    hRun(1880, 400, 148, INT),
  ]);

  const ground: FloorPlan = {
    id: "civic:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    windows: [
      winV(1480, 190),
      winV(1480, 250),
      winV(1480, 440),
      winV(1480, 496),
      winH(1620, 120),
      winH(1680, 120),
      winH(1900, 120),
      winH(1550, 528),
      winH(1630, 528),
      winH(1710, 528),
      winH(1950, 528),
      winH(2010, 528),
      winV(2028, 180),
      winV(2028, 240),
      winV(2028, 320),
      winV(2028, 400),
      winV(2028, 480),
    ],
    objects: [
      ...wcFixtures(),
      // Lobby: reception faces the entrance; lounge seat along the west
      // windows with a round side table.
      obj("receptionDesk", 1640, 300, 28, 120, { facing: "W", scannable: true }),
      obj("couch", 1504, 388, 36, 92, { facing: "E", scannable: true }),
      obj("table", 1556, 428, 40, 40),
      obj("plant", 1500, 320, 20, 20),
      obj("plant", 1500, 500, 20, 20),
      // Café along the south wall: espresso machine ON the counter, fridge
      // closing its east end, one café table clear of the side exit.
      obj("counter", 1560, 494, 110, 24),
      obj("coffeeStation", 1572, 496, 40, 20),
      obj("fridge", 1674, 484, 34, 34, { facing: "N", scannable: true }),
      obj("table", 1740, 430, 48, 48),
      obj("chair", 1714, 444, 20, 20, { facing: "E" }),
      obj("chair", 1794, 444, 20, 20, { facing: "W" }),
      // Mail room SE: lockers along the east wall, sorting counter.
      obj("locker", 1994, 416, 26, 38, { scannable: true }),
      obj("locker", 1994, 458, 26, 38),
      obj("counter", 1896, 484, 80, 22),
      obj("utilityBox", 1900, 420, 26, 20),
      obj("plant", 1852, 330, 20, 20),
    ],
    stairs: [{ id: "civic-g-up", rect: STAIR_A, direction: "up", toFloorId: "civic:F1", bottom: "S" }],
    dotSpawns: [dot(DOT.decoy, 1812, 452), dot(DOT.scanner, 1950, 448)],
  };

  const floorShell = () => perimeter(fp);

  // F1 — open office with a meeting room SE.
  const f1Partitions = mergeRuns([
    coreA(DOWN_DOOR),
    coreB(UP_DOOR),
    wcBlock(),
    vRun(1852, 408, 120, INT, [{ at: 32, w: DOOR }]),
    hRun(1852, 400, 176, INT),
  ]);
  const f1: FloorPlan = {
    id: "civic:F1",
    label: "F1",
    walls: [...floorShell().walls, ...f1Partitions.walls],
    doorways: [...floorShell().doorways, ...f1Partitions.doorways],
    windows: upperWindows(),
    objects: [
      ...wcFixtures(),
      // Two facing desk rows south of the core corridor, with clear lanes
      // along the west window wall and past the meeting room.
      obj("desk", 1540, 390, 96, 46, { facing: "S", scannable: true }),
      obj("desk", 1680, 390, 96, 46, { facing: "S" }),
      obj("desk", 1540, 470, 96, 46, { facing: "N" }),
      obj("desk", 1680, 470, 96, 46, { facing: "N" }),
      obj("filingCabinet", 1996, 320, 30, 48, { scannable: true }),
      obj("filingCabinet", 1996, 372, 30, 48),
      // Meeting room SE.
      obj("conferenceTable", 1924, 420, 96, 56, { scannable: true }),
      // Break corner SW.
      obj("coffeeStation", 1500, 500, 44, 22),
      obj("table", 1560, 496, 44, 44),
      obj("chair", 1610, 508, 20, 20, { facing: "W" }),
      obj("plant", 1810, 500, 20, 20),
    ],
    stairs: [
      { id: "civic-f1-down", rect: STAIR_A, direction: "down", toFloorId: OUTDOOR_FLOOR_ID, bottom: "S" },
      { id: "civic-f1-up", rect: STAIR_B, direction: "up", toFloorId: "civic:F2", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.decoy, 1760, 344), dot(DOT.shield, 1890, 492)],
  };

  // F2 — data floor: secured server room in the center bay, with an open
  // records zone along the east windows.
  const f2Partitions = mergeRuns([
    coreA(UP_DOOR),
    coreB(DOWN_DOOR),
    wcBlock(),
    hRun(1612, 320, 264, INT, [{ at: 140, w: DOOR }]),
    vRun(1612, 328, 172, INT),
    vRun(1868, 328, 172, INT),
    hRun(1612, 500, 264, INT),
  ]);
  const f2: FloorPlan = {
    id: "civic:F2",
    label: "F2",
    walls: [...floorShell().walls, ...f2Partitions.walls],
    doorways: [...floorShell().doorways, ...f2Partitions.doorways],
    windows: upperWindows(),
    objects: [
      ...wcFixtures(),
      // Server room: rack row against the south wall, power plant west.
      obj("serverRack", 1640, 424, 36, 70, { facing: "N", scannable: true }),
      obj("serverRack", 1690, 424, 36, 70, { facing: "N" }),
      obj("serverRack", 1740, 424, 36, 70, { facing: "N" }),
      obj("generator", 1630, 340, 70, 48, { scannable: true }),
      obj("hvac", 1796, 424, 64, 46),
      obj("utilityBox", 1630, 396, 26, 20),
      // Records: filing along the east wall outside the room.
      obj("filingCabinet", 1996, 330, 30, 48),
      obj("filingCabinet", 1996, 382, 30, 48),
      obj("crateStack", 1996, 460, 34, 34),
      obj("plant", 1500, 320, 20, 20),
    ],
    stairs: [
      { id: "civic-f2-down", rect: STAIR_B, direction: "down", toFloorId: "civic:F1", bottom: "S" },
      { id: "civic-f2-up", rect: STAIR_A, direction: "up", toFloorId: "civic:F3", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.scanner, 1720, 400), dot(DOT.regen, 1960, 460)],
  };

  // F3 — executive floor: two offices west, boardroom east, lounge center.
  // Room fronts sit at y 316 so a full-width corridor clears the core band.
  const f3Partitions = mergeRuns([
    coreA(DOWN_DOOR),
    coreB(UP_DOOR),
    wcBlock(),
    // Boardroom east.
    vRun(1852, 316, 212, INT, [{ at: 74, w: DOOR }]),
    hRun(1852, 316, 176, INT),
    // Offices west.
    hRun(1492, 316, 168, INT),
    vRun(1652, 316, 112, INT, [{ at: 20, w: DOOR }]),
    hRun(1492, 428, 168, INT),
    vRun(1652, 428, 100, INT, [{ at: 22, w: DOOR }]),
  ]);
  const f3: FloorPlan = {
    id: "civic:F3",
    label: "F3",
    walls: [...floorShell().walls, ...f3Partitions.walls],
    doorways: [...floorShell().doorways, ...f3Partitions.doorways],
    windows: upperWindows(),
    objects: [
      ...wcFixtures(),
      // Boardroom.
      obj("conferenceTable", 1896, 336, 110, 60, { scannable: true }),
      obj("cabinet", 1950, 490, 70, 24),
      obj("plant", 1866, 496, 20, 20),
      // Office 1 (north).
      obj("desk", 1504, 332, 80, 52, { facing: "S", scannable: true }),
      obj("couch", 1504, 388, 70, 34, { facing: "N" }),
      // Office 2 (south).
      obj("desk", 1504, 452, 80, 52, { facing: "S" }),
      obj("plant", 1626, 504, 20, 20),
      // Lounge center, kept east of the office doors.
      obj("rug", 1700, 350, 150, 130),
      obj("couch", 1710, 360, 90, 38, { facing: "S" }),
      obj("table", 1724, 416, 44, 44),
      obj("plant", 1810, 330, 20, 20),
    ],
    stairs: [
      { id: "civic-f3-down", rect: STAIR_A, direction: "down", toFloorId: "civic:F2", bottom: "S" },
      { id: "civic-f3-up", rect: STAIR_B, direction: "up", toFloorId: "civic:F4", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.rare, 1940, 420), dot(DOT.damage, 1730, 490)],
  };

  // F4 — operations: incident table, dispatch desks, equipment wall.
  const f4Partitions = mergeRuns([coreA(UP_DOOR), coreB(DOWN_DOOR), wcBlock()]);
  const f4: FloorPlan = {
    id: "civic:F4",
    label: "F4",
    walls: [...floorShell().walls, ...f4Partitions.walls],
    doorways: [...floorShell().doorways, ...f4Partitions.doorways],
    windows: upperWindows(),
    objects: [
      ...wcFixtures(),
      obj("conferenceTable", 1640, 350, 170, 70, { scannable: true }),
      obj("desk", 1540, 470, 96, 46, { facing: "N" }),
      obj("desk", 1680, 470, 96, 46, { facing: "N" }),
      obj("serverRack", 1996, 320, 26, 56),
      obj("serverRack", 1996, 384, 26, 56),
      obj("locker", 1860, 488, 26, 38),
      obj("locker", 1890, 488, 26, 38),
      obj("locker", 1920, 488, 26, 38),
      obj("crateStack", 1996, 460, 34, 34),
      obj("plant", 1500, 320, 20, 20),
    ],
    stairs: [
      { id: "civic-f4-down", rect: STAIR_B, direction: "down", toFloorId: "civic:F3", bottom: "S" },
      { id: "civic-f4-up", rect: STAIR_A, direction: "up", toFloorId: "civic:F5", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.shield, 1600, 420), dot(DOT.scanner, 1900, 360)],
  };

  // F5 — studio floor: worktable pairs, materials wall.
  const f5Partitions = mergeRuns([coreA(DOWN_DOOR), coreB(UP_DOOR), wcBlock()]);
  const f5: FloorPlan = {
    id: "civic:F5",
    label: "F5",
    walls: [...floorShell().walls, ...f5Partitions.walls],
    doorways: [...floorShell().doorways, ...f5Partitions.doorways],
    windows: upperWindows(),
    objects: [
      ...wcFixtures(),
      obj("workbench", 1560, 340, 150, 32, { facing: "S", scannable: true }),
      obj("workbench", 1780, 340, 150, 32, { facing: "S" }),
      obj("workbench", 1560, 450, 150, 32, { facing: "N" }),
      obj("workbench", 1780, 450, 150, 32, { facing: "N" }),
      obj("chair", 1600, 388, 20, 20, { facing: "N" }),
      obj("chair", 1660, 388, 20, 20, { facing: "N" }),
      obj("chair", 1820, 388, 20, 20, { facing: "N" }),
      obj("chair", 1880, 388, 20, 20, { facing: "N" }),
      obj("shelf", 1996, 330, 26, 140),
      obj("crateStack", 1520, 500, 34, 34),
      obj("plant", 1950, 502, 20, 20),
    ],
    stairs: [
      { id: "civic-f5-down", rect: STAIR_A, direction: "down", toFloorId: "civic:F4", bottom: "S" },
      { id: "civic-f5-up", rect: STAIR_B, direction: "up", toFloorId: "civic:F6", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.dash, 1700, 420), dot(DOT.decoy, 1520, 420)],
  };

  // F6 — commons: lounge group, library wall, coffee bar.
  const f6Partitions = mergeRuns([coreA(UP_DOOR), coreB(DOWN_DOOR), wcBlock()]);
  const f6: FloorPlan = {
    id: "civic:F6",
    label: "F6",
    walls: [...floorShell().walls, ...f6Partitions.walls],
    doorways: [...floorShell().doorways, ...f6Partitions.doorways],
    windows: upperWindows(),
    objects: [
      ...wcFixtures(),
      obj("rug", 1600, 350, 240, 160),
      obj("couch", 1640, 360, 110, 40, { facing: "S", scannable: true }),
      obj("couch", 1610, 420, 40, 90, { facing: "E" }),
      obj("table", 1720, 410, 56, 56),
      obj("shelf", 1700, 498, 130, 26),
      obj("shelf", 1850, 498, 130, 26),
      obj("counter", 1500, 320, 90, 24),
      obj("coffeeStation", 1520, 296, 44, 22),
      obj("table", 1960, 340, 48, 48),
      obj("chair", 1942, 352, 20, 20, { facing: "E" }),
      obj("chair", 2012, 352, 20, 20, { facing: "W" }),
      obj("plant", 1996, 440, 20, 20),
    ],
    stairs: [
      { id: "civic-f6-down", rect: STAIR_B, direction: "down", toFloorId: "civic:F5", bottom: "S" },
      { id: "civic-f6-up", rect: STAIR_A, direction: "up", toFloorId: "civic:F7", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.regen, 1900, 420), dot(DOT.rare, 1980, 434)],
  };

  // F7 — mechanical penthouse: plant, comms, spares.
  const f7Partitions = mergeRuns([coreA(DOWN_DOOR), coreB(UP_DOOR), wcBlock()]);
  const f7: FloorPlan = {
    id: "civic:F7",
    label: "F7",
    walls: [...floorShell().walls, ...f7Partitions.walls],
    doorways: [...floorShell().doorways, ...f7Partitions.doorways],
    windows: upperWindows(),
    objects: [
      // The WC stack becomes janitor space up here.
      obj("drum", 1720, 146, 24, 24),
      obj("drum", 1750, 210, 24, 24),
      obj("drum", 1800, 140, 24, 24),
      obj("sink", 1830, 142, 22, 16),
      // Plant floor.
      obj("hvac", 1590, 340, 70, 50),
      obj("hvac", 1680, 340, 70, 50),
      obj("generator", 1840, 340, 74, 52, { scannable: true }),
      obj("serverRack", 1996, 320, 26, 50),
      obj("serverRack", 1996, 378, 26, 50),
      obj("serverRack", 1996, 436, 26, 50),
      obj("workbench", 1600, 470, 120, 30, { facing: "N", scannable: true }),
      obj("toolCabinet", 1740, 474, 44, 26),
      obj("drum", 1530, 478, 24, 24),
      obj("drum", 1558, 478, 24, 24),
      obj("vent", 1520, 320, 22, 22),
      obj("vent", 1950, 504, 22, 22),
      obj("utilityBox", 1770, 344, 26, 20),
    ],
    stairs: [
      { id: "civic-f7-down", rect: STAIR_A, direction: "down", toFloorId: "civic:F6", bottom: "S" },
      { id: "civic-f7-up", rect: STAIR_B, direction: "up", toFloorId: "civic:ROOF", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.damage, 1750, 420), dot(DOT.rare, 1880, 440)],
  };

  // ROOF — equipment field north, skylights south, terrace corner SE.
  const roofPartitions = mergeRuns([
    coreB(DOWN_DOOR),
    // Shaft A continues as a closed machine-room bulkhead.
    vRun(1580, 132, 160, INT, [{ at: UP_DOOR, w: DOOR }]),
    hRun(1492, 292, 96, INT),
  ]);
  const roof: FloorPlan = {
    id: "civic:ROOF",
    label: "ROOF",
    walls: [...floorShell().walls, ...roofPartitions.walls],
    doorways: [...floorShell().doorways, ...roofPartitions.doorways],
    objects: [
      // Machine room inside the A bulkhead.
      obj("generator", 1504, 160, 64, 46),
      obj("utilityBox", 1520, 230, 26, 20),
      // HVAC field.
      obj("hvac", 1650, 180, 72, 52),
      obj("hvac", 1740, 180, 72, 52),
      obj("hvac", 1650, 260, 72, 52),
      obj("vent", 1840, 190, 22, 22),
      obj("vent", 1840, 240, 22, 22),
      obj("utilityBox", 1880, 190, 26, 20),
      // Skylights over the south floor plate.
      obj("skylight", 1600, 400, 110, 70),
      obj("skylight", 1760, 400, 110, 70),
      // Terrace corner SE.
      obj("planter", 1930, 470, 30, 90, { solid: false }),
      obj("bench", 1880, 480, 90, 22, { facing: "E" }),
      obj("table", 1976, 380, 48, 48),
      obj("chair", 1958, 392, 20, 20, { facing: "E" }),
      obj("chair", 2028, 392, 20, 20, { facing: "W" }),
    ],
    stairs: [{ id: "civic-roof-down", rect: STAIR_B, direction: "down", toFloorId: "civic:F7", bottom: "S" }],
    dotSpawns: [dot(DOT.rare, 1800, 330)],
  };

  return {
    id: "civic",
    kind: "office",
    name: "CIVIC TOWER",
    footprint: fp,
    floors: [ground, f1, f2, f3, f4, f5, f6, f7, roof],
  };
}

// ---------------------------------------------------------------------------
// Lot 6 Depot — warehouse, SW quadrant. Footprint 160,1000 700x460.
//
// Two roll-up doors feed a dock strip; three rack runs fill the center with
// wide picking aisles; workshop SW, dispatch office SE, stair to the cellar
// NE. Columns align with the racking. B1: generator room and cage storage.
// ---------------------------------------------------------------------------

function lot6Depot(): Building {
  const fp = { x: 160, y: 1000, w: 700, h: 460 };

  const groundShell = perimeter(fp, {
    top: [
      { at: 120, w: ROLLUP, open: true },
      { at: 400, w: ROLLUP, open: true },
      { at: 630, w: DOOR }, // person door into the stair core
    ],
  });
  const groundPartitions = mergeRuns([
    // Stair core NE.
    vRun(748, 1012, 148, INT, [{ at: 10, w: DOOR }]),
    hRun(748, 1160, 100, INT),
    // Workshop SW.
    hRun(172, 1180, 128, INT),
    vRun(292, 1180, 268, INT, [{ at: 100, w: DOOR }]),
    // Dispatch office SE.
    hRun(700, 1300, 148, INT, [{ at: 24, w: DOOR }]),
    vRun(700, 1308, 140, INT),
  ]);

  const ground: FloorPlan = {
    id: "lot6:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    windows: [
      winV(848, 1220, 36),
      winV(848, 1280, 36),
      winH(320, 1448, 36),
      winH(520, 1448, 36),
      winH(660, 1448, 36),
      winV(160, 1250, 36),
      winV(160, 1330, 36),
      // Dispatch office overlooks the floor through an interior window.
      winH(812, 1304, 48),
    ],
    objects: [
      // Structure aligned with the racking.
      obj("column", 385, 1124, 16, 16),
      obj("column", 585, 1124, 16, 16),
      // Dock strip staging.
      obj("pallet", 300, 1030, 48, 36),
      obj("pallet", 356, 1044, 48, 36),
      obj("pallet", 580, 1036, 48, 36),
      // Parked against the west wall so the dock strip stays a clean lane.
      obj("forklift", 180, 1032, 44, 96, { facing: "S", solid: true }),
      obj("drum", 250, 1092, 24, 24),
      // Rack runs with wide aisles.
      obj("shelf", 380, 1160, 26, 220, { scannable: true }),
      obj("shelf", 500, 1160, 26, 220),
      obj("shelf", 620, 1160, 26, 220),
      obj("crateStack", 652, 1192, 34, 34),
      obj("crateStack", 652, 1240, 34, 34),
      obj("drum", 668, 1400, 26, 26),
      // Workshop.
      obj("workbench", 180, 1200, 112, 34, { facing: "S", scannable: true }),
      obj("toolCabinet", 180, 1402, 44, 26, { scannable: true }),
      obj("locker", 180, 1300, 26, 38),
      obj("locker", 180, 1342, 26, 38),
      obj("crateStack", 246, 1408, 32, 32),
      // Dispatch office.
      obj("desk", 716, 1368, 90, 44, { facing: "N" }),
      obj("filingCabinet", 812, 1318, 28, 46),
      obj("plant", 824, 1424, 18, 18),
    ],
    stairs: [
      {
        id: "lot6-stair-down",
        rect: { x: 756, y: 1012, w: 88, h: 148 },
        direction: "down",
        toFloorId: "lot6:B1",
        bottom: "S",
      },
    ],
    dotSpawns: [dot(DOT.damage, 560, 1080), dot(DOT.shield, 452, 1270)],
  };

  const b1Shell = perimeter(fp);
  const b1Partitions = mergeRuns([
    // Stair core NE (same shaft), entered from the cellar at its south end.
    vRun(748, 1012, 148, INT, [{ at: 84, w: DOOR }]),
    hRun(748, 1160, 100, INT),
    // Generator room west.
    vRun(340, 1012, 168, INT, [{ at: 56, w: DOOR }]),
    hRun(172, 1180, 176, INT),
  ]);

  const b1: FloorPlan = {
    id: "lot6:B1",
    label: "B1",
    walls: [...b1Shell.walls, ...b1Partitions.walls],
    doorways: [...b1Shell.doorways, ...b1Partitions.doorways],
    objects: [
      // Generator room.
      obj("generator", 190, 1030, 72, 52, { scannable: true }),
      obj("drum", 292, 1030, 24, 24),
      obj("drum", 292, 1062, 24, 24),
      obj("utilityBox", 190, 1120, 40, 22),
      obj("vent", 300, 1140, 22, 22),
      // Cage storage: three rack runs.
      obj("shelf", 420, 1060, 26, 220),
      obj("shelf", 520, 1060, 26, 220),
      obj("shelf", 620, 1060, 26, 220),
      obj("crateStack", 700, 1320, 34, 34),
      obj("crateStack", 740, 1380, 34, 34),
      // Locker wall and maintenance bench along the south.
      obj("locker", 420, 1400, 26, 38, { scannable: true }),
      obj("locker", 450, 1400, 26, 38),
      obj("locker", 480, 1400, 26, 38),
      obj("locker", 510, 1400, 26, 38),
      obj("workbench", 600, 1402, 110, 28, { facing: "N" }),
    ],
    stairs: [
      {
        id: "lot6-stair-up",
        rect: { x: 756, y: 1012, w: 88, h: 148 },
        direction: "up",
        toFloorId: OUTDOOR_FLOOR_ID,
        bottom: "S",
      },
    ],
    dotSpawns: [dot(DOT.damage, 480, 1340), dot(DOT.rare, 700, 1230)],
  };

  return {
    id: "lot6",
    kind: "warehouse",
    name: "LOT 6 DEPOT",
    footprint: fp,
    floors: [ground, b1],
  };
}

// ---------------------------------------------------------------------------
// Beacon House — residential, SE quadrant. Footprint 1560,1020 520x400.
//
// GROUND: mail room and kitchen flank the entry lobby; commons in the middle
// with a WC; laundry occupies the base of the SE shaft. Stair core west.
// F1: central corridor, three studio apartments and a lounge.
// ROOF: garden terrace. Courtyard park east of the building.
// ---------------------------------------------------------------------------

function beaconHouse(): Building {
  const fp = { x: 1560, y: 1020, w: 520, h: 400 };

  const STAIR_A = { x: 1572, y: 1200, w: 88, h: 160 }; // west core, GROUND↔F1
  const STAIR_B = { x: 1980, y: 1248, w: 88, h: 160 }; // east core, F1↔ROOF

  const coreAWalls = (doorAt: number): RunResult =>
    mergeRuns([
      hRun(1572, 1192, 96, INT),
      vRun(1660, 1200, 160, INT, [{ at: doorAt, w: DOOR }]),
      hRun(1572, 1360, 96, INT),
    ]);
  const coreBWalls = (doorAt?: number): RunResult =>
    mergeRuns([
      hRun(1972, 1240, 96, INT),
      vRun(1972, 1248, 160, INT, doorAt === undefined ? [] : [{ at: doorAt, w: DOOR }]),
    ]);

  const groundShell = perimeter(fp, {
    top: [{ at: 206, w: DOUBLE }], // entrance from Main St into the lobby
    right: [{ at: 100, w: DOOR }], // courtyard door through the kitchen
  });
  const groundPartitions = mergeRuns([
    coreAWalls(88), // up-stair entered from the commons at its south end
    // Mail room NW: south wall with door into the west strip.
    hRun(1572, 1192, 196, INT, [{ at: 96, w: DOOR }]),
    vRun(1760, 1032, 160, INT),
    // Kitchen NE: west wall and south wall with door.
    vRun(1852, 1032, 160, INT),
    hRun(1852, 1192, 216, INT, [{ at: 56, w: DOOR }]),
    // Laundry in the SE shaft base, entered from the west.
    coreBWalls(10),
    // Commons WC.
    hRun(1888, 1320, 92, INT),
    vRun(1888, 1328, 80, INT, [{ at: 12, w: DOOR }]),
  ]);

  const ground: FloorPlan = {
    id: "beacon:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    windows: [
      winH(1620, 1020),
      winH(1700, 1020),
      winH(1920, 1020),
      winH(2000, 1020),
      winV(1560, 1080),
      winV(1560, 1140),
      winV(2080, 1090),
      winV(2080, 1150),
      winV(2080, 1330),
      winH(1720, 1408),
      winH(1800, 1408),
    ],
    objects: [
      // Mail room: lockers and a parcel counter.
      obj("locker", 1584, 1042, 26, 42, { scannable: true }),
      obj("locker", 1614, 1042, 26, 42),
      obj("locker", 1644, 1042, 26, 42),
      obj("counter", 1584, 1120, 22, 60),
      obj("crateStack", 1716, 1096, 30, 30),
      // Kitchen: worktop run, stove, fridge, breakfast table.
      obj("counter", 1868, 1042, 140, 24),
      obj("sink", 1904, 1046, 26, 16),
      obj("stove", 2012, 1042, 44, 26),
      obj("fridge", 1866, 1140, 34, 46, { facing: "E", scannable: true }),
      obj("table", 1912, 1088, 90, 52),
      obj("chair", 1890, 1100, 20, 20, { facing: "E" }),
      obj("chair", 2004, 1100, 20, 20, { facing: "W" }),
      // Commons: rug anchors a couch against the south wall; the center
      // stays open so the lobby, stair, WC, and laundry all connect.
      obj("rug", 1700, 1240, 200, 140),
      obj("couch", 1720, 1360, 110, 40, { facing: "N", scannable: true }),
      obj("table", 1770, 1280, 48, 48),
      obj("chair", 1746, 1292, 20, 20, { facing: "E" }),
      obj("chair", 1824, 1292, 20, 20, { facing: "W" }),
      obj("plant", 1676, 1386, 20, 20),
      obj("plant", 2044, 1210, 20, 20),
      // WC.
      obj("toilet", 1938, 1368, 26, 34, { facing: "S" }),
      obj("sink", 1900, 1330, 22, 16),
      // Laundry (SE shaft base): stacked machines along the east wall.
      obj("washer", 2016, 1260, 36, 36),
      obj("washer", 2016, 1304, 36, 36),
      obj("washer", 2016, 1348, 36, 36),
      obj("sink", 1988, 1384, 24, 16),
    ],
    stairs: [{ id: "beacon-g-up", rect: STAIR_A, direction: "up", toFloorId: "beacon:F1", bottom: "S" }],
    dotSpawns: [dot(DOT.regen, 1786, 1240), dot(DOT.scanner, 2030, 1120)],
  };

  const f1Shell = perimeter(fp);
  const f1Partitions = mergeRuns([
    coreAWalls(8), // down-stair entered from the corridor at its north end
    coreBWalls(96), // up-stair entered from the lounge at its south end
    // Corridor walls with apartment doors and the open lounge arch.
    hRun(1572, 1192, 496, INT, [
      { at: 150, w: DOOR }, // NW studio
      { at: 330, w: DOOR }, // NE studio
    ]),
    hRun(1668, 1272, 400, INT, [
      { at: 60, w: DOOR }, // SW studio
      { at: 180, w: 124, open: true }, // lounge arch
    ]),
    // Apartment party walls.
    vRun(1800, 1032, 160, INT),
    vRun(1840, 1280, 128, INT),
    vRun(1660, 1368, 40, INT),
    // NW studio bath.
    hRun(1572, 1108, 92, INT, [{ at: 24, w: DOOR }]),
    vRun(1656, 1044, 64, INT),
    // NE studio bath.
    hRun(1976, 1108, 92, INT, [{ at: 12, w: DOOR }]),
    vRun(1976, 1044, 64, INT),
    // SW studio bath.
    hRun(1668, 1332, 92, INT, [{ at: 26, w: DOOR }]),
    vRun(1752, 1340, 68, INT),
  ]);

  const f1: FloorPlan = {
    id: "beacon:F1",
    label: "F1",
    walls: [...f1Shell.walls, ...f1Partitions.walls],
    doorways: [...f1Shell.doorways, ...f1Partitions.doorways],
    windows: [
      winH(1700, 1020),
      winH(1760, 1020),
      winH(1860, 1020),
      winH(1930, 1020),
      winH(2010, 1020),
      winV(1560, 1080),
      winV(1560, 1140),
      winV(2080, 1080),
      winV(2080, 1140),
      winH(1730, 1408),
      winH(1800, 1408),
      winH(1900, 1408),
    ],
    objects: [
      // NW studio: bath NW, bed beside it, kitchenette east wall. The strip
      // south of the bed stays clear — it links the bath to the front door.
      obj("bed", 1672, 1044, 48, 92, { facing: "N", scannable: true }),
      obj("cabinet", 1730, 1044, 44, 24),
      obj("counter", 1776, 1076, 22, 48),
      obj("chair", 1620, 1150, 20, 20, { facing: "E" }),
      obj("rug", 1596, 1128, 56, 56),
      obj("toilet", 1590, 1052, 26, 34, { facing: "N" }),
      obj("sink", 1624, 1050, 22, 16),
      // NE studio: mirrored bath, bed west, dining center.
      obj("bed", 1830, 1044, 48, 92, { facing: "N" }),
      obj("cabinet", 1890, 1044, 44, 24),
      obj("table", 1888, 1096, 44, 44),
      obj("chair", 1866, 1106, 20, 20, { facing: "E" }),
      obj("fridge", 1816, 1156, 30, 32, { facing: "N" }),
      obj("toilet", 2020, 1052, 26, 34, { facing: "N" }),
      obj("sink", 1990, 1050, 22, 16),
      // SW studio: bath SW, bed east.
      obj("bed", 1790, 1300, 48, 88, { facing: "S", scannable: true }),
      obj("rug", 1694, 1288, 80, 40),
      obj("chair", 1700, 1296, 20, 20, { facing: "E" }),
      obj("toilet", 1690, 1356, 26, 34, { facing: "S" }),
      obj("sink", 1722, 1378, 22, 16),
      // Lounge: reading corner by the south windows; center left open so
      // the roof stair door stays approachable.
      obj("couch", 1856, 1300, 40, 90, { facing: "E" }),
      obj("shelf", 1900, 1382, 60, 22),
      obj("plant", 1946, 1290, 18, 18),
    ],
    stairs: [
      { id: "beacon-f1-down", rect: STAIR_A, direction: "down", toFloorId: OUTDOOR_FLOOR_ID, bottom: "S" },
      { id: "beacon-f1-up", rect: STAIR_B, direction: "up", toFloorId: "beacon:ROOF", bottom: "S" },
    ],
    dotSpawns: [dot(DOT.shield, 1930, 1236), dot(DOT.dash, 1730, 1236)],
  };

  const roofShell = perimeter(fp);
  const roofPartitions = mergeRuns([coreBWalls(8)]);

  const roof: FloorPlan = {
    id: "beacon:ROOF",
    label: "ROOF",
    walls: [...roofShell.walls, ...roofPartitions.walls],
    doorways: [...roofShell.doorways, ...roofPartitions.doorways],
    objects: [
      // Garden beds west.
      obj("planter", 1596, 1060, 36, 110),
      obj("planter", 1676, 1060, 36, 110),
      obj("planter", 1596, 1210, 36, 110),
      obj("planter", 1676, 1210, 36, 110),
      // Potting bench and social corner.
      obj("workbench", 1600, 1360, 110, 30, { facing: "N", scannable: true }),
      obj("bench", 1770, 1080, 100, 22, { facing: "S" }),
      obj("table", 1800, 1250, 48, 48),
      obj("chair", 1782, 1262, 20, 20, { facing: "E" }),
      obj("chair", 1852, 1262, 20, 20, { facing: "W" }),
      obj("plant", 1760, 1180, 24, 24),
      // Service corner NE.
      obj("hvac", 1920, 1080, 70, 50),
      obj("vent", 2010, 1090, 22, 22),
      obj("skylight", 1780, 1160, 90, 56),
      obj("utilityBox", 1930, 1160, 26, 20),
    ],
    stairs: [{ id: "beacon-roof-down", rect: STAIR_B, direction: "down", toFloorId: "beacon:F1", bottom: "S" }],
    dotSpawns: [dot(DOT.rare, 1730, 1140), dot(DOT.regen, 1890, 1320)],
  };

  return {
    id: "beacon",
    kind: "residential",
    name: "BEACON HOUSE",
    footprint: fp,
    floors: [ground, f1, roof],
  };
}

// ---------------------------------------------------------------------------
// Outdoor plan
// ---------------------------------------------------------------------------

function outdoorPlan() {
  const edgeWalls: WallSegment[] = [
    { id: "edge-n", x: 0, y: 0, w: MAP_W, h: EDGE },
    { id: "edge-s", x: 0, y: MAP_H - EDGE, w: MAP_W, h: EDGE },
    { id: "edge-w", x: 0, y: 0, w: EDGE, h: MAP_H },
    { id: "edge-e", x: MAP_W - EDGE, y: 0, w: EDGE, h: MAP_H },
  ];

  const objects: MapObject[] = [
    // Main St trees: north sidewalk, then south (none over the depot apron).
    ...[350, 610, 870, 1420, 1680, 1940, 2200].map((x) => tree(x, 700, 22)),
    ...[1000, 1420, 1680, 1940, 2200].map((x) => tree(x, 900, 22)),
    // Third Ave trees.
    ...[300, 520, 1060].map((y) => tree(1128, y, 20)),
    ...[300, 520, 1000, 1360].map((y) => tree(1312, y, 20)),

    // Clinic forecourt: benches flank the walk to the entrance.
    obj("bench", 380, 640, 90, 22, { facing: "S" }),
    obj("bench", 550, 640, 90, 22, { facing: "S" }),
    obj("planter", 330, 634, 30, 30),
    obj("planter", 650, 634, 30, 30),
    obj("bikeRack", 700, 668, 90, 20, { scannable: true }),
    obj("hydrant", 850, 706, 14, 14),
    // Clinic west: ambulance apron, clear of the corridor door.
    obj("parkingStall", 60, 220, 120, 70),
    obj("car", 66, 232, 108, 46, { facing: "E" }),

    // Tower forecourt on Third Ave.
    obj("planter", 1440, 240, 30, 30),
    obj("planter", 1440, 420, 30, 30),
    obj("bikeRack", 1400, 300, 20, 90),
    obj("bench", 1404, 430, 22, 90, { facing: "E" }),
    obj("lampPost", 1416, 200, 18, 18),
    // Tower parking lot east: two stall columns off a center drive.
    obj("parkingStall", 2100, 160, 130, 62),
    obj("parkingStall", 2100, 240, 130, 62),
    obj("parkingStall", 2100, 320, 130, 62),
    obj("parkingStall", 2100, 400, 130, 62),
    obj("parkingStall", 2244, 160, 130, 62),
    obj("parkingStall", 2244, 240, 130, 62),
    obj("parkingStall", 2244, 320, 130, 62),
    obj("car", 2106, 168, 112, 46, { facing: "W" }),
    obj("car", 2250, 248, 112, 46, { facing: "E" }),
    obj("car", 2106, 408, 112, 46, { facing: "W" }),
    obj("planter", 2160, 480, 120, 28),
    obj("hydrant", 2076, 520, 14, 14),
    // Loading door walk on Main St side of the tower.
    obj("lampPost", 1990, 700, 18, 18),

    // Street parking on Main St.
    obj("parkingStall", 300, 744, 110, 46),
    obj("parkingStall", 420, 744, 110, 46),
    obj("parkingStall", 540, 744, 110, 46),
    obj("car", 308, 748, 100, 40, { facing: "E" }),
    obj("car", 548, 748, 100, 40, { facing: "E" }),
    obj("parkingStall", 1400, 810, 110, 46),
    obj("parkingStall", 1520, 810, 110, 46),
    obj("car", 1528, 814, 100, 40, { facing: "W" }),

    // Depot apron: staging beside the drive, not on it.
    obj("pallet", 204, 936, 48, 36),
    obj("drum", 262, 944, 24, 24),
    obj("dumpster", 880, 940, 56, 30, { solid: true }),
    obj("hydrant", 900, 906, 14, 14),

    // Courtyard park east of Beacon House.
    tree(2180, 1060, 22),
    tree(2320, 1100, 20),
    tree(2170, 1360, 22),
    tree(2300, 1386, 22),
    obj("bench", 2160, 1110, 100, 22, { facing: "S", scannable: true }),
    obj("bench", 2200, 1330, 100, 22, { facing: "N" }),
    obj("planter", 2150, 1024, 40, 28),
    obj("planter", 2330, 1024, 40, 28),
    obj("lampPost", 2350, 1230, 18, 18),

    // Service lane frontage: bins and drums against the south blocks.
    obj("dumpster", 380, 1454, 56, 30, { solid: true }),
    obj("drum", 448, 1458, 24, 24),
    obj("dumpster", 1700, 1454, 56, 30, { solid: true }),
    obj("hydrant", 1140, 1470, 14, 14),
    obj("lampPost", 900, 1474, 18, 18),
  ];

  const dotSpawns: DotSpawn[] = [
    dot(DOT.dash, 1000, 700),
    dot(DOT.dash, 1220, 420),
    dot(DOT.scanner, 2200, 700),
    dot(DOT.shield, 2320, 640),
    dot(DOT.decoy, 520, 1520),
    dot(DOT.regen, 2250, 1230),
  ];

  return {
    roads: [
      { id: "main-st", x: EDGE, y: 740, w: MAP_W - EDGE * 2, h: 120 },
      { id: "third-ave", x: 1160, y: EDGE, w: 120, h: MAP_H - EDGE * 2 },
      { id: "service-lane", x: EDGE, y: 1490, w: MAP_W - EDGE * 2, h: 56 },
    ],
    parks: [{ id: "beacon-courtyard", x: 2140, y: 1020, w: 220, h: 400 }],
    walls: edgeWalls,
    objects,
    dotSpawns,
  };
}

// ---------------------------------------------------------------------------
// Spawns and assembly
// ---------------------------------------------------------------------------

const botSpawns: BotSpawn[] = [
  { id: "player", name: "You", team: "player", color: "#ff3b6b", position: { x: 300, y: 920 }, inventoryDots: 1 },
  { id: "ally-1", name: "Indigo", team: "ally", color: "#2f80ed", position: { x: 380, y: 920 }, inventoryDots: 1 },
  { id: "ally-2", name: "Sky", team: "ally", color: "#56ccf2", position: { x: 240, y: 890 }, inventoryDots: 1 },
  { id: "enemy-1", name: "Ochre", team: "enemy", color: "#f2994a", position: { x: 2280, y: 650 } },
  { id: "enemy-2", name: "Mint", team: "enemy", color: "#27ae60", position: { x: 900, y: 1520 } },
  { id: "enemy-3", name: "Violet", team: "enemy", color: "#9b51e0", position: { x: 1620, y: 800 } },
  { id: "enemy-4", name: "Amber", team: "enemy", color: "#f2c94c", position: { x: 1080, y: 320 } },
  { id: "enemy-5", name: "Slate", team: "enemy", color: "#7f8c8d", position: { x: 500, y: 300 }, floorId: "mercy:F1" },
  { id: "enemy-6", name: "Coal", team: "enemy", color: "#4f5b66", position: { x: 500, y: 1240 }, floorId: "lot6:B1" },
  { id: "enemy-7", name: "Coral", team: "enemy", color: "#ff7f6e", position: { x: 1750, y: 430 }, floorId: "civic:F4" },
  { id: "enemy-8", name: "Plum", team: "enemy", color: "#7d5ba6", position: { x: 1700, y: 430 }, floorId: "civic:F7" },
  { id: "enemy-9", name: "Sage", team: "enemy", color: "#6b8f71", position: { x: 1800, y: 1236 }, floorId: "beacon:F1" },
  { id: "enemy-10", name: "Rose", team: "enemy", color: "#c75b7a", position: { x: 1750, y: 1120 }, floorId: "beacon:ROOF" },
];

export const downtownMap: MapDocument = {
  id: "downtown",
  name: "Downtown",
  width: MAP_W,
  height: MAP_H,
  outdoor: outdoorPlan(),
  buildings: [mercyClinic(), civicTower(), lot6Depot(), beaconHouse()],
  extractionPoints: [
    { id: "extract-north", name: "NORTH PAD", rect: { x: 950, y: 80, w: 110, h: 110 } },
    { id: "extract-depot", name: "DEPOT PAD", rect: { x: 960, y: 1150, w: 110, h: 110 } },
    { id: "extract-park", name: "PARK PAD", rect: { x: 2210, y: 1160, w: 110, h: 110 } },
  ],
  botSpawns,
};
