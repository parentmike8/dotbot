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
} from "../types";

/**
 * Downtown — the first DotBot map, authored entirely as data.
 *
 * Layout (2400 x 1600):
 *   NW  Mercy Clinic   (hospital,  GROUND + F2)
 *   NE  Civic Tower    (office,    GROUND + F2 + ROOF)
 *   SW  Lot 6 Depot    (warehouse, GROUND + B1)
 *   SE  Triangle Park
 *   Main St runs east-west, 3rd Ave runs north-south.
 *   Three extraction pads: north sidewalk, depot yard, park east.
 */

const MAP_W = 2400;
const MAP_H = 1600;
const EDGE = 26;
const EXT = 12; // exterior wall thickness
const INT = 8; // interior partition thickness
const DOOR = 56; // single door gap
const DOUBLE_DOOR = 72;

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

type DoorSpec = { at: number; w: number; open?: boolean };

type RunResult = { walls: WallSegment[]; doorways: Doorway[] };

let wallSeq = 0;
let doorSeq = 0;

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

let objSeq = 0;

function obj(kind: MapObject["kind"], x: number, y: number, w: number, h: number, extra: Partial<MapObject> = {}): MapObject {
  return { id: `o${objSeq++}`, kind, x, y, w, h, ...extra };
}

function tree(cx: number, cy: number, r = 26): MapObject {
  return obj("tree", cx - r, cy - r, r * 2, r * 2);
}

let dotSeq = 0;

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
// Mercy Clinic — hospital, NW quadrant. Footprint 140,120 700x480.
// GROUND: entrance lobby + reception, two exam rooms, ward, pharmacy, stair core.
// F2: open ward, nurse station, supply room.
// ---------------------------------------------------------------------------

function mercyClinic(): Building {
  const fp = { x: 140, y: 120, w: 700, h: 480 };

  const groundShell = perimeter(fp, {
    bottom: [{ at: 340, w: DOUBLE_DOOR }], // main entrance from Main St
    top: [{ at: 560, w: DOOR }], // staff door into pharmacy
  });
  const groundPartitions = mergeRuns([
    // Exam wing (west): corridor wall with a door per exam room.
    vRun(372, 132, 288, INT, [
      { at: 58, w: DOOR },
      { at: 188, w: DOOR },
    ]),
    hRun(152, 272, 220, INT),
    // Ward / pharmacy divider and their south walls.
    vRun(612, 132, 208, INT),
    hRun(380, 332, 240, INT, [{ at: 70, w: DOOR }]),
    hRun(620, 332, 84, INT, [{ at: 14, w: DOOR }]),
    // Stair core, NE of the lobby.
    vRun(704, 340, 130, INT, [{ at: 40, w: DOOR }]),
    hRun(704, 340, 124, INT),
    hRun(704, 462, 124, INT),
  ]);

  const ground: FloorPlan = {
    id: "mercy:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    objects: [
      // Exam room 1 (NW)
      obj("bed", 162, 150, 48, 96, { facing: "N", scannable: true }),
      obj("medicalCabinet", 296, 140, 44, 24, { scannable: true }),
      obj("chair", 320, 220, 22, 22),
      // Exam room 2 (SW)
      obj("bed", 162, 296, 48, 96, { facing: "N", scannable: true }),
      obj("medicalCabinet", 296, 288, 44, 24),
      obj("chair", 320, 368, 22, 22),
      // Ward (north center): bed row leaves a corridor to the exam-room door.
      obj("bed", 436, 144, 48, 96, { facing: "N", scannable: true }),
      obj("bed", 496, 144, 48, 96, { facing: "N" }),
      obj("bed", 556, 144, 48, 96, { facing: "N" }),
      obj("cabinet", 578, 260, 26, 44),
      obj("chair", 420, 272, 22, 22),
      // Pharmacy (NE): shelving aisle open from the south, counter by the door.
      obj("shelf", 786, 150, 26, 120, { scannable: true }),
      obj("shelf", 700, 150, 26, 120),
      obj("locker", 636, 140, 26, 38, { scannable: true }),
      obj("counter", 732, 144, 48, 22),
      // Lobby: reception + waiting row.
      obj("receptionDesk", 430, 396, 150, 26, { facing: "S", scannable: true }),
      obj("chair", 190, 470, 22, 22),
      obj("chair", 234, 470, 22, 22),
      obj("chair", 278, 470, 22, 22),
      obj("chair", 322, 470, 22, 22),
      obj("plant", 166, 548, 20, 20),
      obj("plant", 668, 552, 20, 20),
    ],
    stairs: [
      {
        id: "mercy-stair-up",
        rect: { x: 724, y: 360, w: 96, h: 92 },
        direction: "up",
        toFloorId: "mercy:F2",
        landing: { x: 772, y: 406 },
      },
    ],
    dotSpawns: [dot(DOT.regen, 250, 200), dot(DOT.shield, 766, 210)],
  };

  const f2Shell = perimeter(fp);
  const f2Partitions = mergeRuns([
    // Ward south wall with two openings.
    hRun(152, 312, 676, INT, [
      { at: 228, w: DOOR },
      { at: 488, w: DOOR },
    ]),
    // Supply room (SW).
    vRun(340, 420, 168, INT, [{ at: 50, w: DOOR }]),
    hRun(152, 420, 196, INT),
    // Stair core (same position as GROUND).
    vRun(704, 340, 130, INT, [{ at: 40, w: DOOR }]),
    hRun(704, 340, 124, INT),
    hRun(704, 462, 124, INT),
  ]);

  const f2: FloorPlan = {
    id: "mercy:F2",
    label: "F2",
    walls: [...f2Shell.walls, ...f2Partitions.walls],
    doorways: [...f2Shell.doorways, ...f2Partitions.doorways],
    objects: [
      // Recovery ward: five beds against the north wall.
      obj("bed", 200, 144, 48, 96, { facing: "N" }),
      obj("bed", 290, 144, 48, 96, { facing: "N", scannable: true }),
      obj("bed", 380, 144, 48, 96, { facing: "N" }),
      obj("bed", 470, 144, 48, 96, { facing: "N" }),
      obj("cot", 690, 148, 44, 88, { facing: "N", scannable: true }),
      obj("medicalCabinet", 590, 142, 44, 24),
      obj("chair", 640, 260, 22, 22),
      // Nurse station on the open floor.
      obj("counter", 420, 380, 140, 26, { scannable: true }),
      obj("chair", 470, 420, 22, 22),
      obj("cot", 600, 470, 44, 88, { facing: "S" }),
      obj("medicalCabinet", 760, 500, 44, 26),
      obj("plant", 668, 552, 20, 20),
      // Supply room shelving.
      obj("shelf", 164, 440, 26, 120),
      obj("shelf", 240, 546, 90, 26),
      obj("cabinet", 296, 436, 32, 26),
    ],
    stairs: [
      {
        id: "mercy-stair-down",
        rect: { x: 724, y: 360, w: 96, h: 92 },
        direction: "down",
        toFloorId: OUTDOOR_FLOOR_ID,
        landing: { x: 772, y: 406 },
      },
    ],
    dotSpawns: [dot(DOT.regen, 240, 270), dot(DOT.regen, 520, 270), dot(DOT.rare, 240, 500)],
  };

  return {
    id: "mercy",
    kind: "hospital",
    name: "MERCY CLINIC",
    footprint: fp,
    floors: [ground, f2],
  };
}

// ---------------------------------------------------------------------------
// Civic Tower — office, NE quadrant. Footprint 1460,120 640x480.
// GROUND: lobby, server room, conference room, open office, stair core.
// F2: desk floor, break room, records room, cores down and up to roof.
// ROOF: parapet, bulkhead, HVAC, skylights.
// ---------------------------------------------------------------------------

function civicTower(): Building {
  const fp = { x: 1460, y: 120, w: 640, h: 480 };

  const groundShell = perimeter(fp, {
    left: [{ at: 210, w: DOUBLE_DOOR }], // main entrance from 3rd Ave
    bottom: [{ at: 440, w: DOOR }], // side exit to Main St
  });
  const groundPartitions = mergeRuns([
    // Stair core NW.
    vRun(1588, 132, 130, INT),
    hRun(1472, 254, 124, INT, [{ at: 28, w: DOOR }]),
    // Server room, north center.
    vRun(1652, 132, 168, INT),
    vRun(1860, 132, 168, INT),
    hRun(1652, 292, 216, INT, [{ at: 78, w: DOOR }]),
    // Conference room NE.
    vRun(1922, 132, 188, INT, [{ at: 78, w: DOOR }]),
    hRun(1922, 312, 166, INT),
    // Lobby / open office divider.
    hRun(1652, 372, 60, INT),
  ]);

  const ground: FloorPlan = {
    id: "civic:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    objects: [
      // Server room racks.
      obj("serverRack", 1672, 142, 36, 70, { facing: "S", scannable: true }),
      obj("serverRack", 1722, 142, 36, 70, { facing: "S" }),
      obj("serverRack", 1772, 142, 36, 70, { facing: "S" }),
      obj("utilityBox", 1826, 146, 24, 20),
      // Conference room.
      obj("conferenceTable", 1958, 180, 104, 62, { scannable: true }),
      // Lobby.
      obj("receptionDesk", 1530, 330, 118, 26, { facing: "W", scannable: true }),
      obj("bench", 1484, 460, 24, 92, { facing: "E" }),
      obj("plant", 1480, 566, 20, 20),
      obj("plant", 1630, 566, 20, 20),
      // Open office SE.
      obj("desk", 1720, 396, 96, 46, { facing: "S", scannable: true }),
      obj("desk", 1720, 480, 96, 46, { facing: "N" }),
      obj("desk", 1898, 396, 96, 46, { facing: "S" }),
      obj("desk", 1898, 480, 96, 46, { facing: "N" }),
      obj("filingCabinet", 2044, 390, 30, 56, { scannable: true }),
      obj("plant", 2056, 552, 20, 20),
    ],
    stairs: [
      {
        id: "civic-stair-up",
        rect: { x: 1482, y: 148, w: 96, h: 92 },
        direction: "up",
        toFloorId: "civic:F2",
        landing: { x: 1530, y: 194 },
      },
    ],
    dotSpawns: [dot(DOT.scanner, 1780, 250), dot(DOT.decoy, 2020, 545)],
  };

  const f2Shell = perimeter(fp);
  const f2Partitions = mergeRuns([
    // Core going down (NW).
    vRun(1588, 132, 130, INT),
    hRun(1472, 254, 124, INT, [{ at: 28, w: DOOR }]),
    // Core going up to roof, just south of it.
    hRun(1472, 278, 124, INT),
    vRun(1588, 278, 122, INT, [{ at: 30, w: DOOR }]),
    hRun(1472, 392, 124, INT),
    // Break room, center south.
    vRun(1650, 400, 188, INT),
    hRun(1650, 392, 240, INT, [{ at: 46, w: DOOR }]),
    vRun(1882, 400, 188, INT),
    // Records room SE.
    vRun(1942, 380, 208, INT, [{ at: 70, w: DOOR }]),
    hRun(1942, 372, 146, INT),
  ]);

  const f2: FloorPlan = {
    id: "civic:F2",
    label: "F2",
    walls: [...f2Shell.walls, ...f2Partitions.walls],
    doorways: [...f2Shell.doorways, ...f2Partitions.doorways],
    objects: [
      // Desk floor, two rows facing each other.
      obj("desk", 1680, 150, 96, 46, { facing: "S" }),
      obj("desk", 1820, 150, 96, 46, { facing: "S", scannable: true }),
      obj("desk", 1960, 150, 96, 46, { facing: "S" }),
      obj("desk", 1680, 244, 96, 46, { facing: "N" }),
      obj("desk", 1820, 244, 96, 46, { facing: "N" }),
      obj("desk", 1960, 244, 96, 46, { facing: "N" }),
      obj("plant", 2062, 330, 20, 20),
      // Break room.
      obj("vending", 1678, 540, 38, 34, { facing: "N", scannable: true }),
      obj("fridge", 1728, 540, 34, 34, { facing: "N", scannable: true }),
      obj("table", 1762, 448, 72, 72),
      obj("couch", 1662, 430, 40, 92, { facing: "E", scannable: true }),
      // Records room: shelving along the north and east walls.
      obj("shelf", 1976, 388, 100, 26),
      obj("shelf", 2056, 440, 26, 110),
      obj("filingCabinet", 1962, 548, 30, 26),
    ],
    stairs: [
      {
        id: "civic-stair-down",
        rect: { x: 1482, y: 148, w: 96, h: 92 },
        direction: "down",
        toFloorId: OUTDOOR_FLOOR_ID,
        landing: { x: 1530, y: 194 },
      },
      {
        id: "civic-stair-roof",
        rect: { x: 1482, y: 292, w: 96, h: 92 },
        direction: "up",
        toFloorId: "civic:ROOF",
        landing: { x: 1530, y: 194 },
      },
    ],
    dotSpawns: [dot(DOT.decoy, 1732, 480), dot(DOT.scanner, 2000, 470)],
  };

  const roofShell = perimeter(fp);
  const roofPartitions = mergeRuns([
    // Stair bulkhead NW.
    vRun(1588, 132, 130, INT),
    hRun(1472, 254, 124, INT, [{ at: 28, w: DOOR }]),
  ]);

  const roof: FloorPlan = {
    id: "civic:ROOF",
    label: "ROOF",
    walls: [...roofShell.walls, ...roofPartitions.walls],
    doorways: [...roofShell.doorways, ...roofPartitions.doorways],
    objects: [
      obj("hvac", 1750, 280, 62, 44),
      obj("hvac", 1836, 280, 62, 44),
      obj("hvac", 1930, 386, 72, 52),
      obj("vent", 1700, 452, 22, 22),
      obj("vent", 2020, 200, 22, 22),
      obj("skylight", 1800, 160, 92, 62),
      obj("skylight", 1950, 480, 82, 52),
    ],
    stairs: [
      {
        id: "civic-roof-down",
        rect: { x: 1482, y: 148, w: 96, h: 92 },
        direction: "down",
        toFloorId: "civic:F2",
        landing: { x: 1530, y: 338 },
      },
    ],
    dotSpawns: [dot(DOT.rare, 2040, 546)],
  };

  return {
    id: "civic",
    kind: "office",
    name: "CIVIC TOWER",
    footprint: fp,
    floors: [ground, f2, roof],
  };
}

// ---------------------------------------------------------------------------
// Lot 6 Depot — warehouse, SW quadrant. Footprint 140,980 760x480.
// GROUND: loading bay with roll-up doors, rack aisles, workshop, office nook,
//         stair core down. B1: generator room, cage storage.
// ---------------------------------------------------------------------------

function lot6Depot(): Building {
  const fp = { x: 140, y: 980, w: 760, h: 480 };

  const groundShell = perimeter(fp, {
    top: [
      { at: 100, w: 120, open: true }, // roll-up A
      { at: 360, w: 120, open: true }, // roll-up B
      { at: 660, w: DOOR }, // person door into stair core
    ],
  });
  const groundPartitions = mergeRuns([
    // Stair core NE (reached from outside or from the floor).
    vRun(756, 992, 128, INT),
    hRun(756, 1112, 132, INT, [{ at: 34, w: DOOR }]),
    // Workshop west.
    hRun(152, 1142, 148, INT, [{ at: 48, w: DOOR }]),
    vRun(292, 1142, 306, INT, [{ at: 108, w: DOOR }]),
    // Office nook SE.
    vRun(712, 1302, 146, INT, [{ at: 48, w: DOOR }]),
    hRun(712, 1302, 176, INT),
  ]);

  const ground: FloorPlan = {
    id: "lot6:GROUND",
    label: "GROUND",
    walls: [...groundShell.walls, ...groundPartitions.walls],
    doorways: [...groundShell.doorways, ...groundPartitions.doorways],
    objects: [
      // Loading bay staging.
      obj("crateStack", 330, 1030, 44, 44, { scannable: true }),
      obj("crateStack", 396, 1052, 44, 44),
      obj("crateStack", 660, 1030, 44, 44),
      // Rack aisles.
      obj("shelf", 370, 1160, 26, 240, { scannable: true }),
      obj("shelf", 460, 1160, 26, 240),
      obj("shelf", 550, 1160, 26, 240),
      obj("shelf", 640, 1160, 26, 240),
      // Workshop.
      obj("workbench", 160, 1388, 120, 36, { facing: "N", scannable: true }),
      obj("toolCabinet", 160, 1160, 44, 28, { scannable: true }),
      obj("crateStack", 228, 1160, 44, 44),
      // Office nook.
      obj("desk", 752, 1330, 96, 46, { facing: "S" }),
      obj("filingCabinet", 852, 1330, 30, 50),
      obj("plant", 856, 1416, 18, 18),
    ],
    stairs: [
      {
        id: "lot6-stair-down",
        rect: { x: 776, y: 1008, w: 96, h: 92 },
        direction: "down",
        toFloorId: "lot6:B1",
        landing: { x: 824, y: 1054 },
      },
    ],
    dotSpawns: [dot(DOT.damage, 210, 1060), dot(DOT.shield, 600, 1300)],
  };

  const b1Shell = perimeter(fp);
  const b1Partitions = mergeRuns([
    // Stair core NE (mirror of GROUND).
    vRun(756, 992, 128, INT),
    hRun(756, 1112, 132, INT, [{ at: 34, w: DOOR }]),
    // Generator room west.
    vRun(332, 992, 188, INT, [{ at: 68, w: DOOR }]),
    hRun(152, 1172, 188, INT),
  ]);

  const b1: FloorPlan = {
    id: "lot6:B1",
    label: "B1",
    walls: [...b1Shell.walls, ...b1Partitions.walls],
    doorways: [...b1Shell.doorways, ...b1Partitions.doorways],
    objects: [
      obj("generator", 170, 1024, 72, 52, { scannable: true }),
      obj("utilityBox", 262, 1010, 26, 22),
      obj("shelf", 420, 1060, 26, 240),
      obj("shelf", 540, 1060, 26, 240),
      obj("shelf", 660, 1060, 26, 240),
      obj("crateStack", 250, 1320, 44, 44),
      obj("crateStack", 318, 1352, 44, 44),
      obj("crateStack", 700, 1380, 44, 44),
      obj("crateStack", 760, 1336, 44, 44),
      obj("locker", 400, 1400, 26, 38),
      obj("locker", 434, 1400, 26, 38),
      obj("locker", 468, 1400, 26, 38, { scannable: true }),
    ],
    stairs: [
      {
        id: "lot6-stair-up",
        rect: { x: 776, y: 1008, w: 96, h: 92 },
        direction: "up",
        toFloorId: OUTDOOR_FLOOR_ID,
        landing: { x: 824, y: 1054 },
      },
    ],
    dotSpawns: [dot(DOT.damage, 210, 1400), dot(DOT.rare, 600, 1400)],
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
    // Main St trees, north then south sidewalk.
    ...[320, 560, 900, 1360, 1620, 1900, 2160].map((x) => tree(x, 692, 24)),
    ...[340, 600, 960, 1400, 1680, 1960, 2240].map((x) => tree(x, 908, 24)),
    // 3rd Ave trees.
    ...[300, 520, 1060, 1340].map((y) => tree(1128, y, 22)),
    ...[260, 480, 1040, 1360].map((y) => tree(1312, y, 22)),
    // Triangle Park.
    tree(1540, 1070, 30),
    tree(1670, 1190, 26),
    tree(1560, 1330, 28),
    tree(1910, 1080, 30),
    tree(2030, 1270, 26),
    tree(1790, 1390, 28),
    obj("bench", 1700, 1100, 80, 22, { facing: "S", scannable: true }),
    obj("bench", 1850, 1300, 80, 22, { facing: "N" }),
    obj("bench", 1620, 1236, 22, 80, { facing: "E" }),
    obj("kiosk", 1946, 1176, 70, 30, { scannable: true }),
    // Clinic entrance benches.
    obj("bench", 396, 632, 80, 22, { facing: "N" }),
    obj("bench", 552, 632, 80, 22, { facing: "N" }),
    // Civic Tower frontage.
    obj("planter", 1424, 296, 26, 26),
    obj("planter", 1424, 420, 26, 26),
    obj("bikeRack", 1396, 640, 92, 22, { scannable: true }),
    // Street details.
    obj("hydrant", 118, 716, 14, 14),
    obj("hydrant", 1308, 946, 14, 14),
    // NE parking lot with painted stalls.
    obj("parkingStall", 2160, 150, 200, 90, { solid: false }),
    obj("parkingStall", 2160, 250, 200, 90, { solid: false }),
    obj("parkingStall", 2160, 350, 200, 90, { solid: false }),
    obj("parkingStall", 2160, 450, 200, 90, { solid: false }),
    obj("car", 2216, 166, 118, 56, { facing: "W" }),
    obj("car", 2216, 366, 118, 56, { facing: "W" }),
    // Cars parked along Main St.
    obj("car", 1520, 806, 112, 48, { facing: "W" }),
    obj("car", 1740, 806, 112, 48, { facing: "E" }),
  ];

  const dotSpawns: DotSpawn[] = [
    dot(DOT.dash, 1000, 660),
    dot(DOT.dash, 1218, 320),
    dot(DOT.scanner, 1740, 1150),
    dot(DOT.shield, 2300, 700),
    dot(DOT.decoy, 450, 1520),
    dot(DOT.regen, 2280, 560),
  ];

  return {
    roads: [
      { id: "main-st", x: EDGE, y: 740, w: MAP_W - EDGE * 2, h: 120 },
      { id: "third-ave", x: 1160, y: EDGE, w: 120, h: MAP_H - EDGE * 2 },
    ],
    parks: [{ id: "triangle-park", x: 1460, y: 1000, w: 690, h: 450 }],
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
  { id: "ally-2", name: "Sky", team: "ally", color: "#56ccf2", position: { x: 236, y: 888 }, inventoryDots: 1 },
  { id: "enemy-1", name: "Ochre", team: "enemy", color: "#f2994a", position: { x: 2280, y: 620 } },
  { id: "enemy-2", name: "Mint", team: "enemy", color: "#27ae60", position: { x: 1750, y: 1240 } },
  { id: "enemy-3", name: "Violet", team: "enemy", color: "#9b51e0", position: { x: 1620, y: 800 } },
  { id: "enemy-4", name: "Amber", team: "enemy", color: "#f2c94c", position: { x: 700, y: 690 } },
  { id: "enemy-5", name: "Slate", team: "enemy", color: "#7f8c8d", position: { x: 490, y: 282 }, floorId: "mercy:F2" },
  { id: "enemy-6", name: "Coal", team: "enemy", color: "#4f5b66", position: { x: 500, y: 1220 }, floorId: "lot6:B1" },
];

export const downtownMap: MapDocument = {
  id: "downtown",
  name: "Downtown",
  width: MAP_W,
  height: MAP_H,
  outdoor: outdoorPlan(),
  buildings: [mercyClinic(), civicTower(), lot6Depot()],
  extractionPoints: [
    { id: "extract-north", name: "NORTH PAD", rect: { x: 950, y: 90, w: 110, h: 110 } },
    { id: "extract-depot", name: "DEPOT PAD", rect: { x: 980, y: 1200, w: 110, h: 110 } },
    { id: "extract-park", name: "PARK PAD", rect: { x: 2220, y: 1180, w: 110, h: 110 } },
  ],
  botSpawns,
};
