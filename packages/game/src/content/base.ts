import { defaultGameConfig } from "../config";
import { isSolidObject, stairExitPoint } from "../mapModel";
import { OUTDOOR_FLOOR_ID } from "../types";
import type {
  BaseLayout,
  BaseObjectKind,
  BaseShellId,
  Building,
  Doorway,
  Facing,
  FloorPlan,
  InteractionDot,
  MapDocument,
  MapObject,
  PlacementSlot,
  Rect,
  StairLink,
  Vec2,
  WallSegment,
  WindowBand,
} from "../types";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 760;

export const BASE_INTERACTION_DOT_RADIUS = defaultGameConfig.dotRadius;

export const BASE_OBJECT_KINDS = [
  "fabricator",
  "bayConsole",
  "planningTable",
  "repairBench",
  "bed",
  "bench",
  "bikeRack",
  "conferenceTable",
  "cot",
  "couch",
  "counter",
  "desk",
  "filingCabinet",
  "fridge",
  "generator",
  "locker",
  "receptionDesk",
  "serverRack",
  "shelf",
  "toolCabinet",
  "workbench",
  "listeningPost",
  "signalMast",
] as const satisfies readonly BaseObjectKind[];

export const BASE_KIND_ZONES: Readonly<Record<BaseObjectKind, readonly ("wall" | "floor")[]>> = {
  fabricator: ["wall"],
  bayConsole: ["wall"],
  repairBench: ["wall"],
  locker: ["wall"],
  shelf: ["wall", "floor"],
  planningTable: ["floor"],
  bed: ["floor"],
  bench: ["floor"],
  bikeRack: ["floor"],
  conferenceTable: ["floor"],
  cot: ["floor"],
  couch: ["floor"],
  counter: ["floor"],
  desk: ["floor"],
  filingCabinet: ["floor"],
  fridge: ["floor"],
  generator: ["floor"],
  receptionDesk: ["floor"],
  serverRack: ["floor"],
  toolCabinet: ["floor"],
  workbench: ["floor"],
  listeningPost: ["wall"],
  signalMast: ["wall"],
};

export const BASE_SHELL_IDS = ["workshop", "hangar", "berths"] as const satisfies readonly BaseShellId[];

export function isBaseShellId(value: unknown): value is BaseShellId {
  return typeof value === "string" && (BASE_SHELL_IDS as readonly string[]).includes(value);
}

/**
 * The canonical slot roster. EVERY shell places exactly these ids with these
 * zones — layouts and loadout rules port between shells untouched, so a shell
 * choice can never grant capacity or capability. Ids are stable labels, not
 * compass positions; each shell decides where its "wall-nw" physically sits.
 */
export const BASE_SLOT_DEFS = [
  { id: "wall-nw", zone: "wall", floor: "GROUND" },
  { id: "wall-n", zone: "wall", floor: "GROUND" },
  { id: "wall-ne", zone: "wall", floor: "GROUND" },
  { id: "wall-east", zone: "wall", floor: "GROUND" },
  { id: "wall-west", zone: "wall", floor: "GROUND" },
  { id: "wall-se", zone: "wall", floor: "GROUND" },
  { id: "floor-nw", zone: "floor", floor: "GROUND" },
  { id: "floor-center", zone: "floor", floor: "GROUND" },
  { id: "floor-ne", zone: "floor", floor: "GROUND" },
  { id: "floor-south", zone: "floor", floor: "GROUND" },
  { id: "up-wall-a", zone: "wall", floor: "F1" },
  { id: "up-wall-b", zone: "wall", floor: "F1" },
  { id: "up-wall-c", zone: "wall", floor: "F1" },
  { id: "up-wall-d", zone: "wall", floor: "F1" },
  { id: "up-floor-a", zone: "floor", floor: "F1" },
  { id: "up-floor-b", zone: "floor", floor: "F1" },
] as const satisfies ReadonlyArray<{ id: string; zone: "wall" | "floor"; floor: "GROUND" | "F1" }>;

export const BASE_GROUND_SLOT_DEFS = BASE_SLOT_DEFS.filter((slot) => slot.floor === "GROUND");
export const BASE_UPPER_SLOT_DEFS = BASE_SLOT_DEFS.filter((slot) => slot.floor === "F1");

type BaseSlotId = (typeof BASE_SLOT_DEFS)[number]["id"];

type ShellSlot = { id: BaseSlotId; rect: Rect; facing: Facing };

type BaseUpperDef = {
  walls: WallSegment[];
  doorways: Doorway[];
  windows: WindowBand[];
  slots: ShellSlot[];
  stairs: { ground: StairLink; upper: StairLink };
};

export type BaseShellDef = {
  id: BaseShellId;
  /** Title-block name, uppercase by convention. */
  name: string;
  /** One-line plan-language description for the shell picker. */
  blurb: string;
  footprint: Rect;
  walls: WallSegment[];
  doorways: Doorway[];
  windows: WindowBand[];
  /** Deployment channel zone just inside the door. */
  deployment: Rect;
  spawn: Vec2;
  slots: ShellSlot[];
  upper: BaseUpperDef;
};

const SINGLETON_BASE_KINDS = new Set<BaseObjectKind>(["fabricator", "bayConsole", "planningTable", "repairBench", "listeningPost", "signalMast"]);

const SLOT_ZONES = new Map<string, "wall" | "floor">(BASE_SLOT_DEFS.map((def) => [def.id, def.zone]));
const SLOT_FLOORS = new Map<string, "GROUND" | "F1">(BASE_SLOT_DEFS.map((def) => [def.id, def.floor]));

// ---------------------------------------------------------------------------
// Shell: WORKSHOP — L-shaped work hall with a south wing and a recessed
// loading dock in the notch. The default shell.
// ---------------------------------------------------------------------------

function workshopShell(): BaseShellDef {
  const walls: WallSegment[] = [
    // Exterior envelope (hall x80..920 y60..480, wing x80..500 y480..700).
    { id: "ws-n", x: 80, y: 60, w: 840, h: 12 },
    { id: "ws-e-hall", x: 908, y: 72, w: 12, h: 408 },
    // Dock wall across the notch, split around the roll-up.
    { id: "ws-dock-w", x: 500, y: 468, w: 140, h: 12 },
    { id: "ws-dock-e", x: 760, y: 468, w: 148, h: 12 },
    { id: "ws-e-wing", x: 488, y: 480, w: 12, h: 220 },
    { id: "ws-s-wing", x: 80, y: 688, w: 408, h: 12 },
    { id: "ws-w", x: 80, y: 72, w: 12, h: 616 },
    // Hall/wing partition with a 120 archway (x200..320 open).
    { id: "ws-part-w", x: 92, y: 468, w: 108, h: 12 },
    { id: "ws-part-e", x: 320, y: 468, w: 168, h: 12 },
    // Structural columns carrying the hall span.
    { id: "ws-col-1", x: 356, y: 258, w: 24, h: 24 },
    { id: "ws-col-2", x: 616, y: 258, w: 24, h: 24 },
    // Dock vestibule cheeks framing the threshold.
    { id: "ws-vest-w", x: 628, y: 408, w: 12, h: 60 },
    { id: "ws-vest-e", x: 760, y: 408, w: 12, h: 60 },
    // Closed dock plate: deployment happens at the grey dot, never on foot.
    // The band sits outside the roll-up so the shutter reads as shut.
    { id: "ws-dock-seal", x: 628, y: 480, w: 144, h: 12 },
    // North-wall pilasters (rhythm only; clear of the wall slots).
    { id: "ws-pil-1", x: 280, y: 72, w: 14, h: 10 },
    { id: "ws-pil-2", x: 530, y: 72, w: 14, h: 10 },
    { id: "ws-pil-3", x: 740, y: 72, w: 14, h: 10 },
  ];
  return {
    id: "workshop",
    name: "WORKSHOP",
    blurb: "L-PLAN WORK HALL · SOUTH WING · RECESSED DOCK",
    footprint: { x: 80, y: 60, w: 840, h: 640 },
    walls,
    doorways: [
      { id: "ws-dock-door", x: 700, y: 474, width: 120, dir: "h", open: true },
      { id: "ws-arch", x: 260, y: 474, width: 120, dir: "h", open: true },
    ],
    windows: [
      { id: "ws-win-n1", x: 278, y: 66, length: 64, dir: "h" },
      { id: "ws-win-n2", x: 508, y: 66, length: 64, dir: "h" },
      { id: "ws-win-n3", x: 800, y: 66, length: 64, dir: "h" },
      { id: "ws-win-w", x: 86, y: 180, length: 64, dir: "v" },
      { id: "ws-win-e", x: 914, y: 330, length: 64, dir: "v" },
      { id: "ws-win-s", x: 250, y: 694, length: 64, dir: "h" },
    ],
    deployment: { x: 640, y: 426, w: 120, h: 38 },
    spawn: { x: 700, y: 360 },
    slots: [
      { id: "wall-nw", rect: { x: 140, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-n", rect: { x: 330, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-ne", rect: { x: 600, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-east", rect: { x: 858, y: 180, w: 38, h: 82 }, facing: "W" },
      { id: "wall-west", rect: { x: 98, y: 540, w: 38, h: 82 }, facing: "E" },
      { id: "wall-se", rect: { x: 444, y: 560, w: 38, h: 82 }, facing: "W" },
      { id: "floor-nw", rect: { x: 210, y: 180, w: 100, h: 68 }, facing: "S" },
      { id: "floor-center", rect: { x: 446, y: 246, w: 108, h: 72 }, facing: "S" },
      { id: "floor-ne", rect: { x: 690, y: 180, w: 100, h: 68 }, facing: "S" },
      { id: "floor-south", rect: { x: 240, y: 540, w: 108, h: 72 }, facing: "S" },
    ],
    upper: {
      // A west/south mezzanine. The east edge is a low parapet with a wide
      // break at the stair sightline so the plan reads as a guarded loft.
      walls: [
        { id: "ws-up-n", x: 92, y: 260, w: 408, h: 12 },
        { id: "ws-up-w", x: 92, y: 272, w: 12, h: 416 },
        { id: "ws-up-s", x: 104, y: 676, w: 384, h: 12 },
        { id: "ws-up-e-n", x: 488, y: 272, w: 12, h: 108 },
        { id: "ws-up-e-s", x: 488, y: 500, w: 12, h: 176 },
      ],
      doorways: [{ id: "ws-up-rail-break", x: 494, y: 440, width: 120, dir: "v", open: true }],
      windows: [
        { id: "ws-up-win-w", x: 98, y: 420, length: 64, dir: "v" },
        { id: "ws-up-win-s", x: 260, y: 682, length: 64, dir: "h" },
      ],
      slots: [
        { id: "up-wall-a", rect: { x: 124, y: 284, w: 86, h: 38 }, facing: "S" },
        { id: "up-wall-b", rect: { x: 376, y: 284, w: 86, h: 38 }, facing: "S" },
        { id: "up-wall-c", rect: { x: 110, y: 500, w: 38, h: 82 }, facing: "E" },
        { id: "up-wall-d", rect: { x: 444, y: 540, w: 38, h: 82 }, facing: "W" },
        { id: "up-floor-a", rect: { x: 340, y: 360, w: 108, h: 72 }, facing: "S" },
        { id: "up-floor-b", rect: { x: 250, y: 560, w: 108, h: 72 }, facing: "S" },
      ],
      stairs: stairPair("ws-mezzanine-stair", { x: 220, y: 310, w: 80, h: 160 }, "S"),
    },
  };
}

// ---------------------------------------------------------------------------
// Shell: HANGAR — one wide bay with a full roll-up strip on the south edge
// and a utility alcove recessed into the north wall.
// ---------------------------------------------------------------------------

function hangarShell(): BaseShellDef {
  const walls: WallSegment[] = [
    // Alcove (x608..912, y60..180) recessed above the main north line.
    { id: "hg-alc-n", x: 608, y: 60, w: 304, h: 12 },
    { id: "hg-alc-w", x: 608, y: 60, w: 12, h: 120 },
    { id: "hg-alc-e", x: 900, y: 60, w: 12, h: 120 },
    // Main north wall either side of the alcove mouth.
    { id: "hg-n-w", x: 60, y: 180, w: 548, h: 12 },
    { id: "hg-n-e", x: 912, y: 180, w: 28, h: 12 },
    { id: "hg-e", x: 928, y: 192, w: 12, h: 416 },
    { id: "hg-w", x: 60, y: 192, w: 12, h: 416 },
    // South wall split around the 240 roll-up strip.
    { id: "hg-s-w", x: 60, y: 608, w: 240, h: 12 },
    { id: "hg-s-e", x: 540, y: 608, w: 400, h: 12 },
    // Closed roll-up plate: the strip is a deployment marker, not an exit.
    { id: "hg-rollup-seal", x: 288, y: 620, w: 264, h: 12 },
    // Columns: a flanking pair at the roll-up, a mid-span pair in the bay.
    { id: "hg-col-sw", x: 276, y: 532, w: 24, h: 24 },
    { id: "hg-col-se", x: 540, y: 532, w: 24, h: 24 },
    { id: "hg-col-w", x: 350, y: 300, w: 24, h: 24 },
    { id: "hg-col-e", x: 626, y: 300, w: 24, h: 24 },
  ];
  return {
    id: "hangar",
    name: "HANGAR",
    blurb: "SINGLE WIDE BAY · ROLL-UP DEPLOYMENT STRIP · UTILITY ALCOVE",
    footprint: { x: 60, y: 60, w: 880, h: 560 },
    walls,
    doorways: [
      { id: "hg-rollup", x: 420, y: 614, width: 240, dir: "h", open: true },
    ],
    windows: [
      { id: "hg-win-n1", x: 200, y: 186, length: 64, dir: "h" },
      { id: "hg-win-n2", x: 430, y: 186, length: 64, dir: "h" },
      { id: "hg-win-alc", x: 760, y: 66, length: 64, dir: "h" },
      { id: "hg-win-w1", x: 66, y: 280, length: 64, dir: "v" },
      { id: "hg-win-w2", x: 66, y: 440, length: 64, dir: "v" },
      { id: "hg-win-e1", x: 934, y: 280, length: 64, dir: "v" },
      { id: "hg-win-e2", x: 934, y: 440, length: 64, dir: "v" },
    ],
    deployment: { x: 300, y: 556, w: 240, h: 44 },
    spawn: { x: 420, y: 480 },
    slots: [
      { id: "wall-nw", rect: { x: 120, y: 204, w: 86, h: 38 }, facing: "S" },
      { id: "wall-n", rect: { x: 330, y: 204, w: 86, h: 38 }, facing: "S" },
      { id: "wall-ne", rect: { x: 648, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-east", rect: { x: 790, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-west", rect: { x: 78, y: 320, w: 38, h: 82 }, facing: "E" },
      { id: "wall-se", rect: { x: 884, y: 460, w: 38, h: 82 }, facing: "W" },
      { id: "floor-nw", rect: { x: 190, y: 330, w: 100, h: 68 }, facing: "S" },
      { id: "floor-center", rect: { x: 446, y: 310, w: 108, h: 72 }, facing: "S" },
      { id: "floor-ne", rect: { x: 700, y: 330, w: 100, h: 68 }, facing: "S" },
      { id: "floor-south", rect: { x: 620, y: 480, w: 108, h: 72 }, facing: "S" },
    ],
    upper: {
      // A utility gallery over the north end; the long south parapet leaves
      // the working bay below visibly double-height.
      walls: [
        { id: "hg-up-n", x: 608, y: 60, w: 320, h: 12 },
        { id: "hg-up-w", x: 608, y: 72, w: 12, h: 348 },
        { id: "hg-up-e", x: 916, y: 72, w: 12, h: 348 },
        { id: "hg-up-s-w", x: 620, y: 408, w: 112, h: 12 },
        { id: "hg-up-s-e", x: 852, y: 408, w: 64, h: 12 },
      ],
      doorways: [{ id: "hg-up-gallery-break", x: 792, y: 414, width: 120, dir: "h", open: true }],
      windows: [
        { id: "hg-up-win-n1", x: 676, y: 66, length: 64, dir: "h" },
        { id: "hg-up-win-n2", x: 824, y: 66, length: 64, dir: "h" },
        { id: "hg-up-win-e", x: 922, y: 180, length: 64, dir: "v" },
      ],
      slots: [
        { id: "up-wall-a", rect: { x: 636, y: 84, w: 86, h: 38 }, facing: "S" },
        { id: "up-wall-b", rect: { x: 792, y: 84, w: 86, h: 38 }, facing: "S" },
        { id: "up-wall-c", rect: { x: 626, y: 220, w: 38, h: 82 }, facing: "E" },
        { id: "up-wall-d", rect: { x: 872, y: 220, w: 38, h: 82 }, facing: "W" },
        { id: "up-floor-a", rect: { x: 744, y: 170, w: 108, h: 72 }, facing: "S" },
        { id: "up-floor-b", rect: { x: 680, y: 300, w: 108, h: 72 }, facing: "S" },
      ],
      stairs: stairPair("hg-gallery-stair", { x: 790, y: 240, w: 80, h: 160 }, "S"),
    },
  };
}

// ---------------------------------------------------------------------------
// Shell: BERTHS — a north commons hall feeding a central corridor with four
// berth alcoves, one slot to a berth. Entry through a proper south door.
// ---------------------------------------------------------------------------

function berthsShell(): BaseShellDef {
  const walls: WallSegment[] = [
    // Commons (x180..820, y60..390).
    { id: "br-n", x: 180, y: 60, w: 640, h: 12 },
    { id: "br-w-commons", x: 180, y: 72, w: 12, h: 306 },
    { id: "br-e-commons", x: 808, y: 72, w: 12, h: 306 },
    // Headers closing the commons floor down to the corridor mouth.
    { id: "br-head-w", x: 180, y: 378, w: 262, h: 12 },
    { id: "br-head-e", x: 558, y: 378, w: 262, h: 12 },
    // Berth block flanks (x230..770, y390..688).
    { id: "br-w-block", x: 230, y: 390, w: 12, h: 298 },
    { id: "br-e-block", x: 758, y: 390, w: 12, h: 298 },
    // South wall split around the entry door.
    { id: "br-s-w", x: 230, y: 688, w: 220, h: 12 },
    { id: "br-s-e", x: 550, y: 688, w: 220, h: 12 },
    // Closed entry plate: deployment happens at the grey dot, never on foot.
    { id: "br-entry-seal", x: 438, y: 700, w: 124, h: 12 },
    // Berth dividers reaching to the corridor line.
    { id: "br-div-w", x: 242, y: 527, w: 200, h: 12 },
    { id: "br-div-e", x: 558, y: 527, w: 200, h: 12 },
    // Berth mouth stubs articulating the corridor edge.
    { id: "br-stub-w1", x: 430, y: 390, w: 12, h: 30 },
    { id: "br-stub-w2", x: 430, y: 539, w: 12, h: 30 },
    { id: "br-stub-e1", x: 558, y: 390, w: 12, h: 30 },
    { id: "br-stub-e2", x: 558, y: 539, w: 12, h: 30 },
  ];
  return {
    id: "berths",
    name: "BERTH ROW",
    blurb: "COMMONS HALL · CENTRAL CORRIDOR · FOUR EQUIPMENT BERTHS",
    footprint: { x: 180, y: 60, w: 640, h: 640 },
    walls,
    doorways: [
      { id: "br-entry", x: 500, y: 694, width: 100, dir: "h" },
      { id: "br-mouth", x: 500, y: 384, width: 116, dir: "h", open: true },
    ],
    windows: [
      { id: "br-win-n1", x: 420, y: 66, length: 64, dir: "h" },
      { id: "br-win-n2", x: 700, y: 66, length: 64, dir: "h" },
      { id: "br-win-w1", x: 186, y: 160, length: 64, dir: "v" },
      { id: "br-win-w2", x: 186, y: 300, length: 64, dir: "v" },
      { id: "br-win-e1", x: 814, y: 160, length: 64, dir: "v" },
      { id: "br-win-e2", x: 814, y: 300, length: 64, dir: "v" },
      { id: "br-win-berth-w", x: 236, y: 450, length: 64, dir: "v" },
      { id: "br-win-berth-e", x: 764, y: 450, length: 64, dir: "v" },
    ],
    deployment: { x: 450, y: 644, w: 100, h: 40 },
    spawn: { x: 500, y: 600 },
    slots: [
      { id: "wall-nw", rect: { x: 280, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-n", rect: { x: 580, y: 84, w: 86, h: 38 }, facing: "S" },
      { id: "wall-ne", rect: { x: 714, y: 568, w: 38, h: 82 }, facing: "W" },
      { id: "wall-east", rect: { x: 714, y: 424, w: 38, h: 82 }, facing: "W" },
      { id: "wall-west", rect: { x: 248, y: 424, w: 38, h: 82 }, facing: "E" },
      { id: "wall-se", rect: { x: 248, y: 568, w: 38, h: 82 }, facing: "E" },
      { id: "floor-nw", rect: { x: 270, y: 190, w: 100, h: 68 }, facing: "S" },
      { id: "floor-center", rect: { x: 450, y: 150, w: 108, h: 72 }, facing: "S" },
      { id: "floor-ne", rect: { x: 630, y: 190, w: 100, h: 68 }, facing: "S" },
      // Keep the central corridor and berth approaches clear even when every
      // slot contains solid fabricated furniture.
      { id: "floor-south", rect: { x: 650, y: 292, w: 108, h: 72 }, facing: "S" },
    ],
    upper: {
      // The commons repeats above the ground commons; the berth block below
      // remains single-storey and outside this upper enclosure.
      walls: [
        { id: "br-up-n", x: 180, y: 60, w: 640, h: 12 },
        { id: "br-up-w", x: 180, y: 72, w: 12, h: 306 },
        { id: "br-up-e", x: 808, y: 72, w: 12, h: 306 },
        { id: "br-up-s-w", x: 192, y: 366, w: 288, h: 12 },
        { id: "br-up-s-e", x: 600, y: 366, w: 208, h: 12 },
      ],
      doorways: [{ id: "br-up-commons-break", x: 540, y: 372, width: 120, dir: "h", open: true }],
      windows: [
        { id: "br-up-win-n1", x: 320, y: 66, length: 64, dir: "h" },
        { id: "br-up-win-n2", x: 620, y: 66, length: 64, dir: "h" },
        { id: "br-up-win-e", x: 814, y: 180, length: 64, dir: "v" },
      ],
      slots: [
        { id: "up-wall-a", rect: { x: 230, y: 84, w: 86, h: 38 }, facing: "S" },
        { id: "up-wall-b", rect: { x: 560, y: 84, w: 86, h: 38 }, facing: "S" },
        { id: "up-wall-c", rect: { x: 198, y: 180, w: 38, h: 82 }, facing: "E" },
        { id: "up-wall-d", rect: { x: 764, y: 180, w: 38, h: 82 }, facing: "W" },
        { id: "up-floor-a", rect: { x: 450, y: 150, w: 108, h: 72 }, facing: "S" },
        { id: "up-floor-b", rect: { x: 620, y: 270, w: 108, h: 72 }, facing: "S" },
      ],
      stairs: stairPair("br-commons-stair", { x: 330, y: 240, w: 80, h: 120 }, "S"),
    },
  };
}

const shellBuilders: Record<BaseShellId, () => BaseShellDef> = {
  workshop: workshopShell,
  hangar: hangarShell,
  berths: berthsShell,
};

const shellCache = new Map<BaseShellId, BaseShellDef>();

export function baseShellDef(shellId: BaseShellId): BaseShellDef {
  let def = shellCache.get(shellId);
  if (!def) {
    def = shellBuilders[shellId]();
    shellCache.set(shellId, def);
  }
  return def;
}

export const DEFAULT_BASE_SHELL: BaseShellId = "workshop";

export const starterBaseLayout: BaseLayout = {
  "wall-nw": "fabricator",
  "wall-n": "locker",
  "wall-ne": "locker",
  "wall-east": "bayConsole",
  "floor-center": "planningTable",
};

export function isBaseObjectKind(value: unknown): value is BaseObjectKind {
  return typeof value === "string" && (BASE_OBJECT_KINDS as readonly string[]).includes(value);
}

export function isObjectAllowedInSlot(kind: BaseObjectKind, slot: Pick<PlacementSlot, "zone">): boolean {
  return BASE_KIND_ZONES[kind].includes(slot.zone);
}

/** Shell-independent: every shell exposes the identical slot roster. */
export function validateBaseLayout(layout: BaseLayout, options: { expanded?: boolean } = {}): void {
  const seenObjects = new Set<BaseObjectKind>();

  for (const [slotId, kind] of Object.entries(layout)) {
    const zone = SLOT_ZONES.get(slotId);
    if (!zone) throw new Error(`Unknown base placement slot: ${slotId}`);
    if (SLOT_FLOORS.get(slotId) === "F1" && !options.expanded) throw new Error(`Base placement slot ${slotId} requires expansion-secondFloor.`);
    if (!isBaseObjectKind(kind)) throw new Error(`Unknown base object kind: ${String(kind)}`);
    if (!isObjectAllowedInSlot(kind, { zone })) throw new Error(`${kind} cannot be placed in ${zone} slot ${slotId}`);
    if (SINGLETON_BASE_KINDS.has(kind) && seenObjects.has(kind)) throw new Error(`Base layout contains duplicate ${kind}`);
    seenObjects.add(kind);
  }
}

/**
 * Builds the chosen base shell from persistent slot data. No runtime counter
 * or random source participates, so equal inputs produce byte-equal
 * documents. Shells differ ONLY in geometry: the slot roster, capacities, and
 * rules are identical across all of them.
 */
export function createBaseMap(layout: BaseLayout, shellId: BaseShellId = DEFAULT_BASE_SHELL, options: { expanded?: boolean } = {}): MapDocument {
  validateBaseLayout(layout, options);
  const shell = baseShellDef(shellId);
  const groundObjects = shell.slots.flatMap((slot) => {
    const kind = layout[slot.id];
    return kind ? [materializeObject(slot, kind)] : [];
  });
  const upperObjects = options.expanded ? shell.upper.slots.flatMap((slot) => {
    const kind = layout[slot.id];
    return kind ? [materializeObject(slot, kind)] : [];
  }) : [];
  const base: Building = {
    id: "player-base",
    kind: "warehouse",
    name: "YOUR BASE",
    footprint: { ...shell.footprint },
    floors: [{
      id: "player-base:GROUND",
      label: "GROUND",
      walls: shell.walls.map((wall) => ({ ...wall })),
      doorways: shell.doorways.map((doorway) => ({ ...doorway })),
      windows: shell.windows.map((window) => ({ ...window })),
      objects: groundObjects,
      stairs: options.expanded ? [{ ...shell.upper.stairs.ground, rect: { ...shell.upper.stairs.ground.rect } }] : [],
      dotSpawns: [],
    }, ...(options.expanded ? [{
      id: "player-base:F1",
      label: "F1" as const,
      walls: shell.upper.walls.map((wall) => ({ ...wall })),
      doorways: shell.upper.doorways.map((doorway) => ({ ...doorway })),
      windows: shell.upper.windows.map((window) => ({ ...window })),
      objects: upperObjects,
      stairs: [{ ...shell.upper.stairs.upper, rect: { ...shell.upper.stairs.upper.rect } }],
      dotSpawns: [],
    }] : [])],
  };

  const map: MapDocument = {
    id: "player-base",
    name: "Base",
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    outdoor: {
      roads: [],
      parks: [],
      walls: sheetEdgeWalls(),
      objects: [],
      dotSpawns: [],
    },
    buildings: [base],
    extractionPoints: [{ id: "base-deployment", name: "DEPLOYMENT", rect: { ...shell.deployment } }],
    insertionPoints: [],
    botSpawns: [{
      id: "player",
      name: "You",
      squadId: "base",
      controller: "human",
      color: "#ff3b6b",
      position: { ...shell.spawn },
      floorId: OUTDOOR_FLOOR_ID,
      bays: [null, null, null, null],
      hold: [],
    }],
    placementSlots: [...shell.slots, ...(options.expanded ? shell.upper.slots : [])].map((slot) => ({
      id: slot.id,
      zone: SLOT_ZONES.get(slot.id)!,
      floor: SLOT_FLOORS.get(slot.id)!,
      rect: { ...slot.rect },
    })),
  };
  map.interactionDots = deriveBaseInteractionDots(map);
  return map;
}

/**
 * Derives the base's complete interaction grammar from placed objects, empty
 * slots, and the deployment threshold. Nothing here is authored per shell.
 */
export function deriveBaseInteractionDots(map: MapDocument): InteractionDot[] {
  const building = map.buildings[0];
  if (!building || !map.placementSlots) return [];

  const dots: InteractionDot[] = [];
  for (const floor of building.floors) {
    const standOnAble = createStandabilityCheck(map, building, floor);
    const slots = map.placementSlots.filter((slot) => slot.floor === floor.label);
    const objectsBySlot = new Map(
      floor.objects.filter((object) => object.slotId).map((object) => [object.slotId!, object]),
    );

    for (const slot of slots) {
      const object = objectsBySlot.get(slot.id);
      if (object) {
        dots.push({
          id: `interaction-object-${object.id}`,
          kind: "object",
          targetId: object.id,
          floorId: floor.id,
          position: objectInteractionPosition(building, floor, object, standOnAble),
          radius: BASE_INTERACTION_DOT_RADIUS,
        });
      } else {
        dots.push({
          id: `interaction-empty-${slot.id}`,
          kind: "emptySlot",
          targetId: slot.id,
          floorId: floor.id,
          position: rectCenter(slot.rect),
          radius: BASE_INTERACTION_DOT_RADIUS,
        });
      }
    }
  }

  const deployment = map.extractionPoints[0];
  const ground = building.floors.find((floor) => floor.label === "GROUND");
  if (deployment && ground) {
    dots.push({
      id: `interaction-deployment-${deployment.id}`,
      kind: "deployment",
      targetId: deployment.id,
      floorId: ground.id,
      position: rectCenter(deployment.rect),
      radius: BASE_INTERACTION_DOT_RADIUS,
    });
  }

  return dots;
}

function objectInteractionPosition(
  building: Building,
  floor: FloorPlan,
  object: MapObject,
  standOnAble: (position: Vec2) => boolean,
): Vec2 {
  const botRadius = defaultGameConfig.botRadius;
  const push = botRadius + BASE_INTERACTION_DOT_RADIUS;
  const preferred = object.facing ?? "S";
  const sideOrder = [preferred, ...(["N", "E", "S", "W"] as const).filter((side) => side !== preferred)];
  const solids: Rect[] = [
    ...floor.walls,
    ...floor.objects.filter((candidate) => candidate.id !== object.id && isSolidObject(candidate)),
  ];
  const valid = (position: Vec2) =>
    insideWithRadius(position, building.footprint, botRadius) &&
    circleClearsRects(position, botRadius - 1, solids) &&
    standOnAble(position);

  for (const side of sideOrder) {
    const position = sideMidpoint(object, side, push);
    if (valid(position)) return position;
  }

  // Match the scannable-dot escape hatch: crowded maximal furnishing can
  // block every first-ring midpoint, so expand along the same side order.
  for (let extra = 8; extra <= 160; extra += 8) {
    for (const side of sideOrder) {
      const position = sideMidpoint(object, side, push + extra);
      if (valid(position)) return position;
    }
  }

  throw new Error(`No bot-clear interaction dot for ${floor.id}/${object.id}`);
}

function createStandabilityCheck(map: MapDocument, building: Building, floor: FloorPlan): (position: Vec2) => boolean {
  const cell = 8;
  const botRadius = defaultGameConfig.botRadius;
  const captureRange = botRadius - BASE_INTERACTION_DOT_RADIUS - 2;
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const solids = floor.label === "GROUND"
    ? [...map.outdoor.walls, ...map.outdoor.objects.filter(isSolidObject), ...floor.walls, ...floor.objects.filter(isSolidObject)]
    : [...floor.walls, ...floor.objects.filter(isSolidObject)];
  const seeds = floor.label === "GROUND"
    ? map.botSpawns.filter((spawn) => spawn.controller === "human").map((spawn) => spawn.position)
    : building.floors.flatMap((other) => other.stairs.filter((stair) => stair.toFloorId === floor.id).map(stairExitPoint));
  const center = (index: number): Vec2 => ({
    x: (index % cols) * cell + cell / 2,
    y: Math.floor(index / cols) * cell + cell / 2,
  });
  const open = (index: number): boolean => {
    const point = center(index);
    return point.x >= botRadius && point.y >= botRadius && point.x <= map.width - botRadius && point.y <= map.height - botRadius &&
      circleClearsRects(point, botRadius - 1, solids);
  };
  const reachable = new Set<number>();
  const queue: number[] = [];
  for (const seed of seeds) {
    const index = Math.floor(seed.y / cell) * cols + Math.floor(seed.x / cell);
    if (open(index)) {
      reachable.add(index);
      queue.push(index);
    }
  }
  while (queue.length > 0) {
    const index = queue.pop()!;
    const col = index % cols;
    for (const next of [index - cols, index + cols, col > 0 ? index - 1 : -1, col < cols - 1 ? index + 1 : -1]) {
      if (next >= 0 && next < cols * rows && !reachable.has(next) && open(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  return (position) => {
    const span = Math.ceil((captureRange + cell) / cell);
    const baseCol = Math.floor(position.x / cell);
    const baseRow = Math.floor(position.y / cell);
    for (let row = baseRow - span; row <= baseRow + span; row += 1) {
      for (let col = baseCol - span; col <= baseCol + span; col += 1) {
        const index = row * cols + col;
        if (reachable.has(index)) {
          const point = center(index);
          if (Math.hypot(point.x - position.x, point.y - position.y) <= captureRange) return true;
        }
      }
    }
    return false;
  };
}

function sideMidpoint(object: MapObject, side: Facing, push: number): Vec2 {
  if (side === "N") return { x: object.x + object.w / 2, y: object.y - push };
  if (side === "E") return { x: object.x + object.w + push, y: object.y + object.h / 2 };
  if (side === "W") return { x: object.x - push, y: object.y + object.h / 2 };
  return { x: object.x + object.w / 2, y: object.y + object.h + push };
}

function rectCenter(rect: Rect): Vec2 {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function insideWithRadius(point: Vec2, bounds: Rect, radius: number): boolean {
  return point.x >= bounds.x + radius && point.x <= bounds.x + bounds.w - radius &&
    point.y >= bounds.y + radius && point.y <= bounds.y + bounds.h - radius;
}

function circleClearsRects(center: Vec2, radius: number, rects: Rect[]): boolean {
  return rects.every((rect) => {
    const dx = center.x - Math.max(rect.x, Math.min(center.x, rect.x + rect.w));
    const dy = center.y - Math.max(rect.y, Math.min(center.y, rect.y + rect.h));
    return dx * dx + dy * dy >= radius * radius;
  });
}

function stairPair(id: string, rect: Rect, bottom: Facing): BaseUpperDef["stairs"] {
  return {
    ground: { id: `${id}-up`, rect: { ...rect }, direction: "up", toFloorId: "player-base:F1", bottom },
    upper: { id: `${id}-down`, rect: { ...rect }, direction: "down", toFloorId: "player-base:GROUND", bottom },
  };
}

function materializeObject(slot: ShellSlot, kind: BaseObjectKind): MapObject {
  return {
    id: `base-object-${slot.id}`,
    kind,
    ...slot.rect,
    facing: slot.facing,
    solid: true,
    slotId: slot.id,
  };
}

function sheetEdgeWalls(): WallSegment[] {
  const edge = 20;
  return [
    { id: "sheet-n", x: 0, y: 0, w: MAP_WIDTH, h: edge },
    { id: "sheet-s", x: 0, y: MAP_HEIGHT - edge, w: MAP_WIDTH, h: edge },
    { id: "sheet-w", x: 0, y: edge, w: edge, h: MAP_HEIGHT - edge * 2 },
    { id: "sheet-e", x: MAP_WIDTH - edge, y: edge, w: edge, h: MAP_HEIGHT - edge * 2 },
  ];
}
