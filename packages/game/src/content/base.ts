import { OUTDOOR_FLOOR_ID } from "../types";
import type {
  BaseLayout,
  BaseObjectKind,
  Building,
  Facing,
  MapDocument,
  MapObject,
  PlacementSlot,
  Rect,
  WallSegment,
} from "../types";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 760;
const SHELL: Rect = { x: 80, y: 60, w: 840, h: 640 };
const WALL = 12;
const DOOR_WIDTH = 120;

export const BASE_OBJECT_KINDS = ["fabricator", "locker", "bayConsole", "planningTable"] as const satisfies readonly BaseObjectKind[];

export const basePlacementSlots: readonly PlacementSlot[] = [
  { id: "wall-nw", rect: { x: 150, y: 84, w: 86, h: 38 }, zone: "wall" },
  { id: "wall-n", rect: { x: 330, y: 84, w: 72, h: 38 }, zone: "wall" },
  { id: "wall-ne", rect: { x: 590, y: 84, w: 72, h: 38 }, zone: "wall" },
  { id: "wall-east", rect: { x: 856, y: 180, w: 38, h: 82 }, zone: "wall" },
  { id: "wall-west", rect: { x: 106, y: 254, w: 38, h: 82 }, zone: "wall" },
  { id: "wall-se", rect: { x: 856, y: 412, w: 38, h: 82 }, zone: "wall" },
  { id: "floor-nw", rect: { x: 246, y: 246, w: 100, h: 68 }, zone: "floor" },
  { id: "floor-center", rect: { x: 450, y: 280, w: 108, h: 72 }, zone: "floor" },
  { id: "floor-ne", rect: { x: 664, y: 246, w: 100, h: 68 }, zone: "floor" },
  { id: "floor-south", rect: { x: 450, y: 470, w: 108, h: 72 }, zone: "floor" },
] as const;

export const starterBaseLayout: BaseLayout = {
  "wall-nw": "fabricator",
  "wall-n": "locker",
  "wall-ne": "locker",
  "wall-east": "bayConsole",
  "floor-center": "planningTable",
};

const wallKinds = new Set<BaseObjectKind>(["fabricator", "locker", "bayConsole"]);

export function isBaseObjectKind(value: unknown): value is BaseObjectKind {
  return typeof value === "string" && (BASE_OBJECT_KINDS as readonly string[]).includes(value);
}

export function isObjectAllowedInSlot(kind: BaseObjectKind, slot: PlacementSlot): boolean {
  return slot.zone === "wall" ? wallKinds.has(kind) : kind === "planningTable";
}

export function validateBaseLayout(layout: BaseLayout): void {
  const slots = new Map(basePlacementSlots.map((slot) => [slot.id, slot]));
  const seenObjects = new Set<BaseObjectKind>();

  for (const [slotId, kind] of Object.entries(layout)) {
    const slot = slots.get(slotId);
    if (!slot) throw new Error(`Unknown base placement slot: ${slotId}`);
    if (!isBaseObjectKind(kind)) throw new Error(`Unknown base object kind: ${String(kind)}`);
    if (!isObjectAllowedInSlot(kind, slot)) throw new Error(`${kind} cannot be placed in ${slot.zone} slot ${slotId}`);
    if (kind !== "locker" && seenObjects.has(kind)) throw new Error(`Base layout contains duplicate ${kind}`);
    seenObjects.add(kind);
  }
}

/**
 * Builds the fixed base shell from persistent slot data. No runtime counter or
 * random source participates, so equal layouts produce byte-equal documents.
 */
export function createBaseMap(layout: BaseLayout): MapDocument {
  validateBaseLayout(layout);
  const doorX = SHELL.x + (SHELL.w - DOOR_WIDTH) / 2;
  const bottomY = SHELL.y + SHELL.h - WALL;
  const walls: WallSegment[] = [
    { id: "base-wall-n", x: SHELL.x, y: SHELL.y, w: SHELL.w, h: WALL },
    { id: "base-wall-w", x: SHELL.x, y: SHELL.y + WALL, w: WALL, h: SHELL.h - WALL * 2 },
    { id: "base-wall-e", x: SHELL.x + SHELL.w - WALL, y: SHELL.y + WALL, w: WALL, h: SHELL.h - WALL * 2 },
    { id: "base-wall-s-w", x: SHELL.x, y: bottomY, w: doorX - SHELL.x, h: WALL },
    { id: "base-wall-s-e", x: doorX + DOOR_WIDTH, y: bottomY, w: SHELL.x + SHELL.w - doorX - DOOR_WIDTH, h: WALL },
  ];
  const objects = basePlacementSlots.flatMap((slot) => {
    const kind = layout[slot.id];
    return kind ? [materializeObject(slot, kind)] : [];
  });
  const base: Building = {
    id: "player-base",
    kind: "warehouse",
    name: "YOUR BASE",
    footprint: SHELL,
    floors: [{
      id: "player-base:GROUND",
      label: "GROUND",
      walls,
      doorways: [{ id: "base-deployment-door", x: doorX + DOOR_WIDTH / 2, y: bottomY + WALL / 2, width: DOOR_WIDTH, dir: "h", open: true }],
      windows: [
        { id: "base-window-nw", x: 260, y: SHELL.y + WALL / 2, length: 64, dir: "h" },
        { id: "base-window-ne", x: 740, y: SHELL.y + WALL / 2, length: 64, dir: "h" },
      ],
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
    extractionPoints: [{ id: "base-deployment", name: "DEPLOYMENT", rect: { x: doorX, y: bottomY - 38, w: DOOR_WIDTH, h: 38 } }],
    botSpawns: [{
      id: "player",
      name: "You",
      squadId: "base",
      controller: "human",
      color: "#ff3b6b",
      position: { x: SHELL.x + SHELL.w / 2, y: bottomY - 104 },
      floorId: OUTDOOR_FLOOR_ID,
      bays: [null, null, null, null],
      hold: [],
    }],
    placementSlots: basePlacementSlots.map((slot) => ({ ...slot, rect: { ...slot.rect } })),
  };
}

function materializeObject(slot: PlacementSlot, kind: BaseObjectKind): MapObject {
  const facing: Facing = slot.id.includes("east") ? "W" : slot.id.includes("west") ? "E" : "S";
  return {
    id: `base-object-${slot.id}`,
    kind,
    ...slot.rect,
    facing,
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
