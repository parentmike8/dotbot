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
 * Mercer Parts — a five-level, code-authored vertical gameplay slice.
 *
 * GROUND  shop and public counter
 * F1      assembly floor
 * F2      parts storage
 * F3      repair floor
 * F4      guarded core bay
 *
 * The two stair runs reuse Downtown's mid-stride floor transition exactly.
 * Their coordinates alternate by floor so climbing also means crossing and
 * learning each level rather than standing in one stairwell for four swaps.
 */

const MAP_W = 1120;
const MAP_H = 820;
const EDGE = 24;
const EXT = 14;
const INT = 8;

export const CORNER_SHOP_FLOORS = {
  ground: "corner-shop:GROUND",
  f1: "corner-shop:F1",
  f2: "corner-shop:F2",
  f3: "corner-shop:F3",
  f4: "corner-shop:F4",
} as const;

const footprint = { x: 120, y: 72, w: 880, h: 650 };

/** Wide walk-through flights. Adjacent-floor pairs always reuse these exact rectangles. */
export const CORNER_SHOP_STAIRS = {
  a: { x: 150, y: 96, w: 104, h: 184 },
  b: { x: 150, y: 470, w: 104, h: 184 },
} as const;

function mercerStair(stair: Omit<StairLink, "access">): StairLink {
  return { ...stair, access: "openEnd" };
}

const POWER = {
  repair: { kind: "powerup", type: "health" },
  dash: { kind: "powerup", type: "dashOvercharge" },
  scan: { kind: "powerup", type: "radar" },
  hide: { kind: "powerup", type: "incognito" },
} as const satisfies Record<string, DotSpawn["item"]>;

function object(
  id: string,
  kind: MapObject["kind"],
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<MapObject> = {},
): MapObject {
  return { id, kind, x, y, w, h, ...extra };
}

function dot(id: string, item: DotSpawn["item"], x: number, y: number): DotSpawn {
  return { id, item, position: { x, y } };
}

function upperShell(prefix: string): WallSegment[] {
  return [
    { id: `${prefix}-wall-n`, x: footprint.x, y: footprint.y, w: footprint.w, h: EXT },
    { id: `${prefix}-wall-w`, x: footprint.x, y: footprint.y + EXT, w: EXT, h: footprint.h - EXT * 2 },
    { id: `${prefix}-wall-e`, x: footprint.x + footprint.w - EXT, y: footprint.y + EXT, w: EXT, h: footprint.h - EXT * 2 },
    { id: `${prefix}-wall-s`, x: footprint.x, y: footprint.y + footprint.h - EXT, w: footprint.w, h: EXT },
  ];
}

function upperWindows(prefix: string): WindowBand[] {
  return [
    { id: `${prefix}-north-a`, x: 350, y: footprint.y + EXT / 2, length: 150, dir: "h" },
    { id: `${prefix}-north-b`, x: 570, y: footprint.y + EXT / 2, length: 150, dir: "h" },
    { id: `${prefix}-north-c`, x: 790, y: footprint.y + EXT / 2, length: 150, dir: "h" },
    { id: `${prefix}-south-a`, x: 350, y: footprint.y + footprint.h - EXT / 2, length: 150, dir: "h" },
    { id: `${prefix}-south-b`, x: 570, y: footprint.y + footprint.h - EXT / 2, length: 150, dir: "h" },
    { id: `${prefix}-south-c`, x: 790, y: footprint.y + footprint.h - EXT / 2, length: 150, dir: "h" },
    { id: `${prefix}-west-a`, x: footprint.x + EXT / 2, y: 360, length: 120, dir: "v" },
    { id: `${prefix}-west-b`, x: footprint.x + EXT / 2, y: 550, length: 120, dir: "v" },
    { id: `${prefix}-east-a`, x: footprint.x + footprint.w - EXT / 2, y: 240, length: 120, dir: "v" },
    { id: `${prefix}-east-b`, x: footprint.x + footprint.w - EXT / 2, y: 390, length: 120, dir: "v" },
  ];
}

function upperFloor(
  id: string,
  label: FloorPlan["label"],
  objects: MapObject[],
  stairs: StairLink[],
  dotSpawns: DotSpawn[],
): FloorPlan {
  return {
    id,
    label,
    walls: upperShell(id),
    doorways: [],
    windows: upperWindows(id),
    objects: [object(`${id}-tiles`, "floorTiles", 134, 86, 852, 622, { solid: false }), ...objects],
    stairs,
    dotSpawns,
  };
}

const groundWalls: WallSegment[] = [
  // Street shell. The south run leaves one genuinely open 96-unit entrance.
  { id: "shop-wall-n", x: footprint.x, y: footprint.y, w: footprint.w, h: EXT },
  { id: "shop-wall-w", x: footprint.x, y: footprint.y + EXT, w: EXT, h: footprint.h - EXT * 2 },
  { id: "shop-wall-e", x: footprint.x + footprint.w - EXT, y: footprint.y + EXT, w: EXT, h: footprint.h - EXT * 2 },
  { id: "shop-wall-s-west", x: footprint.x, y: footprint.y + footprint.h - EXT, w: 392, h: EXT },
  { id: "shop-wall-s-east", x: 608, y: footprint.y + footprint.h - EXT, w: 392, h: EXT },

  // The former stock room is now the public stair hall. Its east wall ends
  // well above the counter and the south edge stays open, producing one broad
  // southeast approach instead of a technically-valid one-bot squeeze.
  { id: "stair-hall-wall-e", x: 372, y: footprint.y + EXT, w: INT, h: 104 },
];

const groundDoorways: Doorway[] = [
  { id: "shop-entry", x: 560, y: footprint.y + footprint.h - EXT / 2, width: 96, dir: "h" },
  { id: "stair-hall-door", x: 376, y: 235, width: 90, dir: "v" },
];

const groundWindows: WindowBand[] = [
  { id: "storefront-west-a", x: 224, y: footprint.y + footprint.h - EXT / 2, length: 146, dir: "h" },
  { id: "storefront-west-b", x: 410, y: footprint.y + footprint.h - EXT / 2, length: 114, dir: "h" },
  { id: "storefront-east-a", x: 710, y: footprint.y + footprint.h - EXT / 2, length: 150, dir: "h" },
  { id: "storefront-east-b", x: 890, y: footprint.y + footprint.h - EXT / 2, length: 112, dir: "h" },
  { id: "north-glass-a", x: 450, y: footprint.y + EXT / 2, length: 130, dir: "h" },
  { id: "north-glass-b", x: 620, y: footprint.y + EXT / 2, length: 130, dir: "h" },
  { id: "north-glass-c", x: 790, y: footprint.y + EXT / 2, length: 130, dir: "h" },
  { id: "north-glass-d", x: 930, y: footprint.y + EXT / 2, length: 74, dir: "h" },
];

const groundObjects: MapObject[] = [
  object("sales-floor-tiles", "floorTiles", 134, 86, 852, 622, { solid: false }),
  object("parts-wall-n", "fridge", 410, 100, 524, 104, { facing: "S", visualStyle: "retail" }),
  object("wall-shelf-e-1", "shelf", 904, 232, 68, 106, { facing: "W", visualStyle: "retail" }),
  object("wall-shelf-e-2", "shelf", 912, 354, 60, 124, { facing: "W", visualStyle: "retail" }),
  object("wall-shelf-e-3", "shelf", 896, 494, 76, 96, { facing: "W", visualStyle: "retail" }),
  object("checkout-counter", "counter", 148, 348, 292, 348, {
    facing: "S",
    visualStyle: "retail",
    collisionParts: [
      { x: 0, y: 0, w: 292, h: 76 },
      { x: 0, y: 76, w: 104, h: 196 },
      { x: 0, y: 272, w: 292, h: 76 },
    ],
  }),
  object("parts-island", "produceDisplay", 534, 268, 280, 228, { facing: "S", visualStyle: "retail" }),
  object("build-station", "kiosk", 760, 560, 76, 92, { facing: "S", visualStyle: "retail" }),
  object("entry-mat", "rug", 520, 638, 80, 46, { solid: false }),
  object("station-mat", "rug", 742, 548, 112, 124, { solid: false }),
];

const ground: FloorPlan = {
  id: CORNER_SHOP_FLOORS.ground,
  label: "GROUND",
  walls: groundWalls,
  doorways: groundDoorways,
  windows: groundWindows,
  objects: groundObjects,
  stairs: [mercerStair({
    id: "mercer-g-up",
    rect: CORNER_SHOP_STAIRS.a,
    direction: "up",
    toFloorId: CORNER_SHOP_FLOORS.f1,
    bottom: "S",
  })],
  dotSpawns: [
    dot("mercer-ground-repair", POWER.repair, 340, 236),
    dot("mercer-ground-scan", POWER.scan, 342, 526),
  ],
};

const f1 = upperFloor(
  CORNER_SHOP_FLOORS.f1,
  "F1",
  [
    // Assembly floor: one central parts island, a straight east circulation
    // lane, and one ordered service wall. Nothing overlaps or floats.
    object("f1-bench-nw", "workbench", 340, 126, 210, 58, { facing: "S" }),
    object("f1-bench-ne", "workbench", 614, 126, 210, 58, { facing: "S" }),
    object("f1-parts-table", "produceDisplay", 360, 260, 370, 124, { visualStyle: "retail" }),
    object("f1-build-line", "counter", 380, 468, 330, 62, { visualStyle: "retail" }),
    object("f1-tool-a", "toolCabinet", 344, 468, 36, 62),
    object("f1-tool-b", "toolCabinet", 726, 468, 36, 62),
    object("f1-lockers", "locker", 840, 112, 108, 118),
    object("f1-tool-wall", "toolCabinet", 840, 246, 108, 58),
    object("f1-station", "kiosk", 850, 320, 86, 96, { visualStyle: "retail" }),
    object("f1-station-mat", "rug", 834, 304, 118, 128, { solid: false }),
    object("f1-fabricator", "fabricator", 840, 432, 108, 106),
    object("f1-fabricator-mat", "rug", 824, 416, 140, 138, { solid: false }),
  ],
  [
    mercerStair({ id: "mercer-f1-down", rect: CORNER_SHOP_STAIRS.a, direction: "down", toFloorId: OUTDOOR_FLOOR_ID, bottom: "S" }),
    mercerStair({ id: "mercer-f1-up", rect: CORNER_SHOP_STAIRS.b, direction: "up", toFloorId: CORNER_SHOP_FLOORS.f2, bottom: "N" }),
  ],
  [
    dot("mercer-f1-dash", POWER.dash, 804, 226),
    dot("mercer-f1-repair", POWER.repair, 306, 574),
  ],
);

const f2 = upperFloor(
  CORNER_SHOP_FLOORS.f2,
  "F2",
  [
    // Storage floor: four equal rack runs feed paired sorting and outbound
    // banks; the east service equipment reads as one aligned wall module.
    object("f2-rack-a", "shelf", 330, 160, 62, 274, { facing: "E", visualStyle: "retail" }),
    object("f2-rack-b", "shelf", 456, 160, 62, 274, { facing: "E", visualStyle: "retail" }),
    object("f2-rack-c", "shelf", 582, 160, 62, 274, { facing: "E", visualStyle: "retail" }),
    object("f2-rack-d", "shelf", 708, 160, 62, 274, { facing: "E", visualStyle: "retail" }),
    object("f2-sort-a", "counter", 330, 516, 220, 58, { visualStyle: "retail" }),
    object("f2-sort-b", "counter", 614, 516, 176, 58, { visualStyle: "retail" }),
    object("f2-inbound-bench", "workbench", 330, 100, 440, 44, { facing: "S" }),
    object("f2-lockers", "locker", 854, 110, 94, 94),
    object("f2-scan-station", "bayConsole", 844, 220, 104, 92),
    object("f2-scan-mat", "rug", 828, 204, 136, 124, { solid: false }),
    object("f2-outbound-a", "counter", 330, 638, 180, 48, { visualStyle: "retail" }),
    object("f2-outbound-b", "counter", 574, 638, 180, 48, { visualStyle: "retail" }),
  ],
  [
    mercerStair({ id: "mercer-f2-down", rect: CORNER_SHOP_STAIRS.b, direction: "down", toFloorId: CORNER_SHOP_FLOORS.f1, bottom: "N" }),
    mercerStair({ id: "mercer-f2-up", rect: CORNER_SHOP_STAIRS.a, direction: "up", toFloorId: CORNER_SHOP_FLOORS.f3, bottom: "S" }),
  ],
  [
    dot("mercer-f2-scan", POWER.scan, 888, 404),
    dot("mercer-f2-hide", POWER.hide, 300, 570),
  ],
);

const f3 = upperFloor(
  CORNER_SHOP_FLOORS.f3,
  "F3",
  [
    // Repair floor: three open service bays, a clear west stair apron, and
    // one aligned east service wall with no decorative dead-end gaps.
    object("f3-repair-a", "workbench", 330, 130, 190, 56, { facing: "S" }),
    object("f3-repair-b", "workbench", 584, 130, 190, 56, { facing: "S" }),
    object("f3-rack-a", "serverRack", 790, 126, 52, 112),
    object("f3-rack-b", "serverRack", 858, 126, 52, 112),
    object("f3-bay-a", "kiosk", 360, 292, 90, 108, { visualStyle: "retail" }),
    object("f3-bay-b", "kiosk", 520, 292, 90, 108, { visualStyle: "retail" }),
    object("f3-bay-c", "kiosk", 680, 292, 90, 108, { visualStyle: "retail" }),
    object("f3-bay-mat-a", "rug", 344, 276, 122, 140, { solid: false }),
    object("f3-bay-mat-b", "rug", 504, 276, 122, 140, { solid: false }),
    object("f3-bay-mat-c", "rug", 664, 276, 122, 140, { solid: false }),
    object("f3-tools", "counter", 350, 522, 390, 58, { visualStyle: "retail" }),
    object("f3-lockers", "locker", 854, 254, 62, 126),
    object("f3-parts-a", "toolCabinet", 316, 300, 44, 74),
    object("f3-parts-b", "toolCabinet", 316, 392, 44, 74),
    object("f3-fabricator", "fabricator", 820, 492, 108, 112),
    object("f3-fabricator-mat", "rug", 804, 476, 140, 144, { solid: false }),
    object("f3-test-console", "bayConsole", 780, 254, 66, 104),
  ],
  [
    mercerStair({ id: "mercer-f3-down", rect: CORNER_SHOP_STAIRS.a, direction: "down", toFloorId: CORNER_SHOP_FLOORS.f2, bottom: "S" }),
    mercerStair({ id: "mercer-f3-up", rect: CORNER_SHOP_STAIRS.b, direction: "up", toFloorId: CORNER_SHOP_FLOORS.f4, bottom: "N" }),
  ],
  [
    dot("mercer-f3-dash", POWER.dash, 824, 430),
    dot("mercer-f3-repair", POWER.repair, 306, 510),
  ],
);

const f4 = upperFloor(
  CORNER_SHOP_FLOORS.f4,
  "F4",
  [
    // Purpose: secure Core processing and the building's strongest reward.
    // Zones: north diagnostics, east storage/loadout, central Core machine,
    // and a joined south repair line. Flow: arrive southwest, choose either
    // side of the central machine, then converge on the Core Dot beyond it.
    // Racks sit beside loadout; tools extend the repair bench; the broad west
    // and east gaps are deliberate combat/circulation space, not empty fill.
    object("f4-bench-north", "workbench", 330, 120, 260, 54, { facing: "S" }),
    object("f4-rack-a", "serverRack", 820, 126, 50, 112),
    object("f4-rack-b", "serverRack", 886, 126, 50, 112),
    object("f4-console", "kiosk", 676, 100, 76, 82, { visualStyle: "retail" }),
    object("f4-console-mat", "rug", 660, 96, 108, 102, { solid: false }),
    object("f4-loadout", "bayConsole", 810, 254, 132, 94),
    object("f4-loadout-mat", "rug", 794, 238, 164, 126, { solid: false }),
    object("f4-lockers", "locker", 952, 126, 22, 112),
    object("f4-core-machine", "fabricator", 480, 270, 180, 140),
    object("f4-core-pad", "rug", 452, 242, 236, 220, { solid: false }),
    object("f4-repair", "repairBench", 320, 540, 184, 72),
    object("f4-tools-a", "toolCabinet", 504, 540, 48, 72),
    object("f4-tools-b", "toolCabinet", 552, 540, 48, 72),
  ],
  [
    mercerStair({ id: "mercer-f4-down", rect: CORNER_SHOP_STAIRS.b, direction: "down", toFloorId: CORNER_SHOP_FLOORS.f3, bottom: "N" }),
  ],
  [
    dot("mercer-f4-rare", POWER.hide, 570, 450),
    dot("mercer-f4-scan", POWER.scan, 680, 520),
  ],
);

const shop: Building = {
  id: "corner-shop",
  kind: "retail",
  name: "MERCER PARTS",
  footprint,
  floors: [ground, f1, f2, f3, f4],
};

const rivalSpawns: BotSpawn[] = [
  // F1 deliberately teaches the alternating stair route before combat begins.
  // All defenders share one squad so the authored encounter survives until a
  // player reaches it instead of resolving itself elsewhere in the building.
  { id: "mercer-rival-f2-a", name: "Olive", squadId: "mercer-defenders", isAmbient: true, color: "#72834a", position: { x: 860, y: 386 }, floorId: CORNER_SHOP_FLOORS.f2 },
  { id: "mercer-rival-f3-a", name: "Rust", squadId: "mercer-defenders", isAmbient: true, color: "#a6503d", position: { x: 850, y: 430 }, floorId: CORNER_SHOP_FLOORS.f3 },
  { id: "mercer-rival-f4-a", name: "Gold", squadId: "mercer-defenders", isAmbient: true, color: "#d3a62f", position: { x: 790, y: 430 }, floorId: CORNER_SHOP_FLOORS.f4 },
  { id: "mercer-rival-f4-b", name: "Ash", squadId: "mercer-defenders", isAmbient: true, color: "#667078", position: { x: 680, y: 650 }, floorId: CORNER_SHOP_FLOORS.f4 },
];

export const cornerShopMap: MapDocument = {
  id: "corner-shop-detail-test",
  name: "Mercer Parts Vertical Test",
  width: MAP_W,
  height: MAP_H,
  outdoor: {
    roads: [{ id: "mercer-street", x: EDGE, y: 760, w: MAP_W - EDGE * 2, h: 36 }],
    parks: [],
    walls: [
      { id: "edge-n", x: 0, y: 0, w: MAP_W, h: EDGE },
      { id: "edge-s", x: 0, y: MAP_H - EDGE, w: MAP_W, h: EDGE },
      { id: "edge-w", x: 0, y: EDGE, w: EDGE, h: MAP_H - EDGE * 2 },
      { id: "edge-e", x: MAP_W - EDGE, y: EDGE, w: EDGE, h: MAP_H - EDGE * 2 },
    ],
    objects: [],
    dotSpawns: [],
  },
  buildings: [shop],
  extractionPoints: [],
  insertionPoints: [{ id: "shop-entry", name: "Parts Shop", position: { x: 560, y: 650 }, floorId: CORNER_SHOP_FLOORS.ground }],
  botSpawns: [
    {
      id: "player",
      name: "YOU",
      squadId: "player-squad",
      controller: "human",
      color: "#f59f00",
      position: { x: 560, y: 650 },
      floorId: CORNER_SHOP_FLOORS.ground,
    },
    ...rivalSpawns,
  ],
  interactionDots: [
    {
      id: "shop-interaction-dot",
      kind: "object",
      targetId: "parts-wall-n",
      floorId: CORNER_SHOP_FLOORS.ground,
      position: { x: 870, y: 238 },
      radius: 10,
    },
  ],
};

export const cornerShopReviewPoints = {
  entry: { x: 560, y: 650 },
  openFloor: { x: 854, y: 344 },
  behindCounter: { x: 340, y: 510 },
  behindCashMachine: { x: 798, y: 526 },
  belowCashMachine: { x: 798, y: 680 },
  stairHall: { x: 270, y: 244 },
  interactionDot: { x: 870, y: 238 },
} as const;
