import { OUTDOOR_FLOOR_ID } from "../types";
import type {
  BaseLayout,
  BaseObjectKind,
  BaseShellId,
  Building,
  Doorway,
  Facing,
  MapDocument,
  MapObject,
  PlacementSlot,
  Rect,
  Vec2,
  WallSegment,
  WindowBand,
} from "../types";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 760;

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
  { id: "wall-nw", zone: "wall" },
  { id: "wall-n", zone: "wall" },
  { id: "wall-ne", zone: "wall" },
  { id: "wall-east", zone: "wall" },
  { id: "wall-west", zone: "wall" },
  { id: "wall-se", zone: "wall" },
  { id: "floor-nw", zone: "floor" },
  { id: "floor-center", zone: "floor" },
  { id: "floor-ne", zone: "floor" },
  { id: "floor-south", zone: "floor" },
] as const satisfies ReadonlyArray<{ id: string; zone: "wall" | "floor" }>;

type BaseSlotId = (typeof BASE_SLOT_DEFS)[number]["id"];

type ShellSlot = { id: BaseSlotId; rect: Rect; facing: Facing };

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
};

const SINGLETON_BASE_KINDS = new Set<BaseObjectKind>(["fabricator", "bayConsole", "planningTable", "repairBench"]);

const SLOT_ZONES = new Map<string, "wall" | "floor">(BASE_SLOT_DEFS.map((def) => [def.id, def.zone]));

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
      { id: "floor-south", rect: { x: 450, y: 286, w: 108, h: 72 }, facing: "S" },
    ],
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
export function validateBaseLayout(layout: BaseLayout): void {
  const seenObjects = new Set<BaseObjectKind>();

  for (const [slotId, kind] of Object.entries(layout)) {
    const zone = SLOT_ZONES.get(slotId);
    if (!zone) throw new Error(`Unknown base placement slot: ${slotId}`);
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
export function createBaseMap(layout: BaseLayout, shellId: BaseShellId = DEFAULT_BASE_SHELL): MapDocument {
  validateBaseLayout(layout);
  const shell = baseShellDef(shellId);
  const objects = shell.slots.flatMap((slot) => {
    const kind = layout[slot.id];
    return kind ? [materializeObject(slot, kind)] : [];
  });
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
      objects,
      stairs: [],
      dotSpawns: [],
    }],
  };

  return {
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
    placementSlots: shell.slots.map((slot) => ({ id: slot.id, zone: SLOT_ZONES.get(slot.id)!, rect: { ...slot.rect } })),
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
