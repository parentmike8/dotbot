import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Application,
  Container,
  Graphics,
  Text,
  TextStyle,
  type Ticker,
} from "pixi.js";
import RAPIER from "@dimforge/rapier2d-compat";

type Vec2 = { x: number; y: number };
type DotType = "dash" | "shield" | "damage" | "scanner" | "decoy" | "regen";
type FloorId =
  | "ground"
  | "station-ground"
  | "clinic-ground"
  | "clinic-f2"
  | "arcade-ground"
  | "arcade-f2"
  | "depot-ground"
  | "depot-b1";
type BotState = "alive" | "downed" | "consumed";
type Direction = "up" | "down" | "left" | "right";

type Wall = { x: number; y: number; w: number; h: number };
type MapLabel = { text: string; x: number; y: number; size: number };
type RoundedZone = { id: string; x: number; y: number; w: number; h: number; radius: number };
type GroundPatchKind = "pocket-park";
type GroundPatch = {
  id: string;
  kind: GroundPatchKind;
  x: number;
  y: number;
  w: number;
  h: number;
  radius?: number;
  dividers?: ("horizontal" | "vertical")[];
};
type Crosswalk = { id: string; x: number; y: number; w: number; h: number; orientation: "horizontal" | "vertical" };
type WindowSlot = { id: string; x: number; y: number; w: number; h: number };
type EdgeWindow = { id: string; edge: number; start: number; size: number; depth?: number };
type DetailLine = { id: string; x1: number; y1: number; x2: number; y2: number; width?: number; alpha?: number };
type FloorDecalKind =
  | "thin-rect"
  | "hatch-box"
  | "panel-grid"
  | "counter-run"
  | "chair-row"
  | "fixture-row"
  | "parking-row"
  | "paver-row"
  | "entry-stairs";
type FloorDecal = {
  id: string;
  kind: FloorDecalKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  arrow?: Direction;
  cells?: number;
  alpha?: number;
};
type RoomOutline = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  gaps?: Gap[];
  alpha?: number;
};
type DoorSwing = { id: string; x: number; y: number; radius: number; start: number; end: number };
type Plant = { id: string; x: number; y: number; radius: number; kind: "tree" | "planter" | "shrub" | "lamp" };
type StreetFixtureKind = "bollard" | "utility-cover" | "sign";
type StreetFixture = {
  id: string;
  x: number;
  y: number;
  radius: number;
  kind: StreetFixtureKind;
};
type ExtractionZone = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  arrow: Direction;
  accent?: number;
};
type BuildingFootprint = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  outline?: Vec2[];
  entry?: Vec2;
  windowSpecs?: EdgeWindow[];
};
type Dot = {
  id: string;
  type: DotType;
  x: number;
  y: number;
  radius: number;
  captureMs: number;
  capturedMs: number;
};
type MapObjectKind =
  | "bench"
  | "locker"
  | "medical-cot"
  | "desk"
  | "counter"
  | "shelf"
  | "crate"
  | "table"
  | "dining-table"
  | "plant-bed"
  | "server-rack"
  | "sofa"
  | "car"
  | "bed"
  | "kitchen-island"
  | "vending-machine"
  | "round-planter"
  | "washroom"
  | "armchair"
  | "file-cabinet";
type ObjectCategory = "street" | "seating" | "storage" | "medical" | "work" | "home" | "utility" | "decor";
type MapObjectDefinition = {
  label: string;
  category: ObjectCategory;
  w: number;
  h: number;
  shape?: "rect" | "circle";
  scanPadding?: number;
};
type FloorDecalCategory = "floor" | "street" | "building" | "furniture" | "utility" | "wayfinding";
type FloorDecalDefinition = {
  label: string;
  category: FloorDecalCategory;
  color: number;
  defaultAlpha: number;
};
type GroundPatchCategory = "park" | "plaza";
type GroundPatchDefinition = {
  label: string;
  category: GroundPatchCategory;
  fill: number;
  stroke: number;
  defaultAlpha: number;
};
type StreetFixtureCategory = "street" | "utility" | "wayfinding";
type StreetFixtureDefinition = {
  label: string;
  category: StreetFixtureCategory;
  color: number;
  defaultAlpha: number;
};
type ScanObject = {
  id: string;
  kind: MapObjectKind;
  x: number;
  y: number;
  rotation?: number;
  scannable: boolean;
  scanMs: number;
  scannedMs: number;
  completed: boolean;
};
type Stair = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visual?: "entry" | "stairs";
  toFloor: FloorId;
  toPosition: Vec2;
};
type TestBot = {
  id: string;
  label: string;
  color: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  shields: number;
  maxShields: number;
  state: BotState;
  inventory: DotType[];
  channelMs: number;
  hitCooldownMs: number;
  floor: FloorId;
};
type FloorConfig = {
  id: FloorId;
  label: string;
  camera: Wall;
  area?: Wall;
  walls: Wall[];
  dots: Dot[];
  objects: ScanObject[];
  stairs: Stair[];
  roads?: Wall[];
  sidewalks?: Wall[];
  curbs?: RoundedZone[];
  patches?: GroundPatch[];
  crosswalks?: Crosswalk[];
  plants?: Plant[];
  fixtures?: StreetFixture[];
  buildings?: BuildingFootprint[];
  windows?: WindowSlot[];
  linework?: DetailLine[];
  decals?: FloorDecal[];
  rooms?: RoomOutline[];
  doors?: DoorSwing[];
  extractionZones?: ExtractionZone[];
  labels: MapLabel[];
};
type HudState = {
  floorLabel: string;
  shields: number;
  maxShields: number;
  inventory: DotType[];
  message: string;
  nearScan: boolean;
  nearStairs: boolean;
  scanProgress: number;
  consumeProgress: number;
  reviveProgress: number;
  repairCooldownMs: number;
};

type GameControls = {
  move: Vec2;
  scanHeld: boolean;
};

const DOT_COLORS: Record<DotType, number> = {
  dash: 0x2f80ed,
  shield: 0x2dbf7f,
  damage: 0xf05252,
  scanner: 0xf2c94c,
  decoy: 0x9b51e0,
  regen: 0x27ae60,
};

const DOT_NAMES: Record<DotType, string> = {
  dash: "Dash",
  shield: "Shield",
  damage: "Damage",
  scanner: "Scanner",
  decoy: "Decoy",
  regen: "Regen",
};

const OBJECT_DEFINITIONS: Record<MapObjectKind, MapObjectDefinition> = {
  bench: { label: "Bench", category: "street", w: 72, h: 22, scanPadding: 18 },
  locker: { label: "Locker", category: "storage", w: 68, h: 34, scanPadding: 20 },
  "medical-cot": { label: "Medical Cot", category: "medical", w: 90, h: 36, scanPadding: 20 },
  desk: { label: "Desk", category: "work", w: 76, h: 42, scanPadding: 20 },
  counter: { label: "Counter", category: "work", w: 96, h: 32, scanPadding: 22 },
  shelf: { label: "Shelf", category: "storage", w: 92, h: 28, scanPadding: 20 },
  crate: { label: "Crate", category: "storage", w: 44, h: 44, scanPadding: 18 },
  table: { label: "Round Table", category: "seating", w: 82, h: 82, shape: "circle", scanPadding: 14 },
  "dining-table": { label: "Dining Table", category: "seating", w: 112, h: 62, scanPadding: 18 },
  "plant-bed": { label: "Planter", category: "decor", w: 54, h: 32, scanPadding: 16 },
  "server-rack": { label: "Server Rack", category: "utility", w: 80, h: 34, scanPadding: 20 },
  sofa: { label: "Sofa", category: "seating", w: 82, h: 38, scanPadding: 20 },
  car: { label: "Car", category: "street", w: 48, h: 88, scanPadding: 22 },
  bed: { label: "Bed", category: "home", w: 78, h: 46, scanPadding: 20 },
  "kitchen-island": { label: "Kitchen Island", category: "home", w: 112, h: 42, scanPadding: 22 },
  "vending-machine": { label: "Vending Machine", category: "utility", w: 34, h: 70, scanPadding: 20 },
  "round-planter": { label: "Round Planter", category: "decor", w: 46, h: 46, shape: "circle", scanPadding: 14 },
  washroom: { label: "Washroom Fixtures", category: "utility", w: 64, h: 46, scanPadding: 20 },
  armchair: { label: "Armchair", category: "seating", w: 38, h: 34, scanPadding: 16 },
  "file-cabinet": { label: "File Cabinet", category: "storage", w: 48, h: 28, scanPadding: 16 },
};

const FLOOR_DECAL_DEFINITIONS: Record<FloorDecalKind, FloorDecalDefinition> = {
  "thin-rect": { label: "Thin Rectangle Detail", category: "floor", color: 0x111111, defaultAlpha: 0.5 },
  "hatch-box": { label: "Service Hatch", category: "utility", color: 0x111111, defaultAlpha: 0.66 },
  "panel-grid": { label: "Panel Grid", category: "building", color: 0x111111, defaultAlpha: 0.62 },
  "counter-run": { label: "Counter Run", category: "furniture", color: 0x111111, defaultAlpha: 0.72 },
  "chair-row": { label: "Chair Row", category: "furniture", color: 0x111111, defaultAlpha: 0.78 },
  "fixture-row": { label: "Fixture Row", category: "utility", color: 0x111111, defaultAlpha: 0.68 },
  "parking-row": { label: "Parking Row", category: "street", color: 0x8f969f, defaultAlpha: 0.34 },
  "paver-row": { label: "Paver Row", category: "street", color: 0xb8bec6, defaultAlpha: 0.32 },
  "entry-stairs": { label: "Entry Stairs", category: "wayfinding", color: 0x111111, defaultAlpha: 0.86 },
};

const GROUND_PATCH_DEFINITIONS: Record<GroundPatchKind, GroundPatchDefinition> = {
  "pocket-park": { label: "Pocket Park", category: "park", fill: 0xfcfcfc, stroke: 0xd2d5d9, defaultAlpha: 1 },
};

const STREET_FIXTURE_DEFINITIONS: Record<StreetFixtureKind, StreetFixtureDefinition> = {
  bollard: { label: "Bollard", category: "street", color: 0x111111, defaultAlpha: 0.48 },
  "utility-cover": { label: "Utility Cover", category: "utility", color: 0x111111, defaultAlpha: 0.42 },
  sign: { label: "Signal Marker", category: "wayfinding", color: 0x111111, defaultAlpha: 0.55 },
};

const toHexColor = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

const PLAYER_RADIUS = 21;
const DOTBOT_COLOR = 0x111111;
const MOVE_SPEED = 260;
const DASH_SPEED = 720;
const HIT_SPEED = 360;
const CONSUME_MS = 2300;
const REVIVE_MS = 2300;
const REPAIR_COOLDOWN_MS = 9000;
const WALL_EPSILON = 0.01;
const MAP_W = 2400;
const MAP_H = 1600;
const WALL_THICKNESS = 18;
const START_POSITION = { x: 1260, y: 1240 };

const cloneDots = (dots: Omit<Dot, "capturedMs">[]): Dot[] =>
  dots.map((dot) => ({ ...dot, capturedMs: 0 }));

const cloneObjects = (
  objects: Omit<ScanObject, "scannedMs" | "completed">[],
): ScanObject[] =>
  objects.map((object) => ({ ...object, scannedMs: 0, completed: false }));

type Gap = { side: "top" | "bottom" | "left" | "right"; start: number; size: number };
type EdgeGap = { edge: number; start: number; size: number };

const boundsWalls = (): Wall[] => [
  { x: 0, y: 0, w: MAP_W, h: 24 },
  { x: 0, y: MAP_H - 24, w: MAP_W, h: 24 },
  { x: 0, y: 0, w: 24, h: MAP_H },
  { x: MAP_W - 24, y: 0, w: 24, h: MAP_H },
];

const wallSegments = (start: number, end: number, gaps: { start: number; end: number }[]) => {
  const sorted = gaps
    .map((gap) => ({
      start: Math.max(start, Math.min(end, gap.start)),
      end: Math.max(start, Math.min(end, gap.end)),
    }))
    .filter((gap) => gap.end > gap.start)
    .sort((a, b) => a.start - b.start);
  const segments: { start: number; end: number }[] = [];
  let cursor = start;
  for (const gap of sorted) {
    if (gap.start > cursor) segments.push({ start: cursor, end: gap.start });
    cursor = Math.max(cursor, gap.end);
  }
  if (cursor < end) segments.push({ start: cursor, end });
  return segments;
};

const shellWalls = (
  x: number,
  y: number,
  w: number,
  h: number,
  gaps: Gap[] = [],
  thickness = WALL_THICKNESS,
): Wall[] => {
  const topGaps = gaps
    .filter((gap) => gap.side === "top")
    .map((gap) => ({ start: x + gap.start, end: x + gap.start + gap.size }));
  const bottomGaps = gaps
    .filter((gap) => gap.side === "bottom")
    .map((gap) => ({ start: x + gap.start, end: x + gap.start + gap.size }));
  const leftGaps = gaps
    .filter((gap) => gap.side === "left")
    .map((gap) => ({ start: y + gap.start, end: y + gap.start + gap.size }));
  const rightGaps = gaps
    .filter((gap) => gap.side === "right")
    .map((gap) => ({ start: y + gap.start, end: y + gap.start + gap.size }));

  return [
    ...wallSegments(x, x + w, topGaps).map((segment) => ({
      x: segment.start,
      y,
      w: segment.end - segment.start,
      h: thickness,
    })),
    ...wallSegments(x, x + w, bottomGaps).map((segment) => ({
      x: segment.start,
      y: y + h - thickness,
      w: segment.end - segment.start,
      h: thickness,
    })),
    ...wallSegments(y, y + h, leftGaps).map((segment) => ({
      x,
      y: segment.start,
      w: thickness,
      h: segment.end - segment.start,
    })),
    ...wallSegments(y, y + h, rightGaps).map((segment) => ({
      x: x + w - thickness,
      y: segment.start,
      w: thickness,
      h: segment.end - segment.start,
    })),
  ];
};

const outlineWalls = (
  points: Vec2[],
  gaps: EdgeGap[] = [],
  thickness = WALL_THICKNESS,
): Wall[] => {
  const walls: Wall[] = [];
  if (points.length < 2) return walls;

  for (let edge = 0; edge < points.length; edge++) {
    const a = points[edge];
    const b = points[(edge + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.abs(dx) + Math.abs(dy);
    if (length <= 0 || (Math.abs(dx) > 0 && Math.abs(dy) > 0)) continue;

    const edgeGaps = gaps
      .filter((gap) => gap.edge === edge)
      .map((gap) => ({ start: gap.start, end: gap.start + gap.size }));

    for (const segment of wallSegments(0, length, edgeGaps)) {
      if (Math.abs(dx) > 0) {
        const sign = Math.sign(dx);
        const x1 = a.x + sign * segment.start;
        const x2 = a.x + sign * segment.end;
        walls.push({
          x: Math.min(x1, x2),
          y: a.y - thickness / 2,
          w: Math.abs(x2 - x1),
          h: thickness,
        });
      } else {
        const sign = Math.sign(dy);
        const y1 = a.y + sign * segment.start;
        const y2 = a.y + sign * segment.end;
        walls.push({
          x: a.x - thickness / 2,
          y: Math.min(y1, y2),
          w: thickness,
          h: Math.abs(y2 - y1),
        });
      }
    }
  }

  return walls;
};

const outlineWindowSlots = (
  points: Vec2[],
  specs: EdgeWindow[],
  defaultDepth = 8,
): WindowSlot[] =>
  specs.flatMap((spec) => {
    if (points.length < 2) return [];
    const a = points[spec.edge];
    const b = points[(spec.edge + 1) % points.length];
    if (!a || !b) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.abs(dx) + Math.abs(dy);
    if (length <= 0 || (Math.abs(dx) > 0 && Math.abs(dy) > 0)) return [];

    const start = Math.max(0, Math.min(length, spec.start));
    const end = Math.max(0, Math.min(length, spec.start + spec.size));
    if (end <= start) return [];

    const depth = spec.depth ?? defaultDepth;
    if (Math.abs(dx) > 0) {
      const sign = Math.sign(dx);
      const x1 = a.x + sign * start;
      const x2 = a.x + sign * end;
      return [{ id: spec.id, x: Math.min(x1, x2), y: a.y - depth / 2, w: Math.abs(x2 - x1), h: depth }];
    }

    const sign = Math.sign(dy);
    const y1 = a.y + sign * start;
    const y2 = a.y + sign * end;
    return [{ id: spec.id, x: a.x - depth / 2, y: Math.min(y1, y2), w: depth, h: Math.abs(y2 - y1) }];
  });

const cityRoads: Wall[] = [
  { x: 0, y: 600, w: MAP_W, h: 130 },
  { x: 0, y: 1180, w: MAP_W, h: 130 },
  { x: 830, y: 0, w: 130, h: MAP_H },
  { x: 1650, y: 0, w: 130, h: MAP_H },
];

const citySidewalks: Wall[] = [
  { x: 0, y: 560, w: MAP_W, h: 40 },
  { x: 0, y: 730, w: MAP_W, h: 40 },
  { x: 0, y: 1140, w: MAP_W, h: 40 },
  { x: 0, y: 1310, w: MAP_W, h: 40 },
  { x: 790, y: 0, w: 40, h: MAP_H },
  { x: 960, y: 0, w: 40, h: MAP_H },
  { x: 1610, y: 0, w: 40, h: MAP_H },
  { x: 1780, y: 0, w: 40, h: MAP_H },
];

const cityCurbs: RoundedZone[] = [
  { id: "curb-clinic", x: 210, y: 150, w: 620, h: 420, radius: 28 },
  { id: "curb-arcade", x: 1028, y: 118, w: 585, h: 495, radius: 26 },
  { id: "curb-depot", x: 1788, y: 188, w: 475, h: 585, radius: 24 },
  { id: "curb-annex", x: 238, y: 818, w: 535, h: 365, radius: 26 },
  { id: "curb-station", x: 1008, y: 928, w: 625, h: 315, radius: 28 },
  { id: "curb-labs", x: 1818, y: 948, w: 425, h: 375, radius: 24 },
  { id: "curb-planter", x: 1126, y: 1360, w: 420, h: 72, radius: 18 },
];

const cityCrosswalks: Crosswalk[] = [
  { id: "crosswalk-west-1", x: 760, y: 608, w: 54, h: 108, orientation: "vertical" },
  { id: "crosswalk-east-1", x: 1788, y: 608, w: 54, h: 108, orientation: "vertical" },
  { id: "crosswalk-west-2", x: 760, y: 1190, w: 54, h: 108, orientation: "vertical" },
  { id: "crosswalk-east-2", x: 1788, y: 1190, w: 54, h: 108, orientation: "vertical" },
  { id: "crosswalk-main-south", x: 1210, y: 1318, w: 150, h: 54, orientation: "horizontal" },
];

const cityPatches: GroundPatch[] = [
  {
    id: "central-pocket-park",
    kind: "pocket-park",
    x: 1120,
    y: 820,
    w: 360,
    h: 210,
    dividers: ["horizontal", "vertical"],
  },
];

const clinicOutline: Vec2[] = [
  { x: 240, y: 180 },
  { x: 800, y: 180 },
  { x: 800, y: 540 },
  { x: 620, y: 540 },
  { x: 620, y: 500 },
  { x: 420, y: 500 },
  { x: 420, y: 540 },
  { x: 240, y: 540 },
];

const arcadeOutline: Vec2[] = [
  { x: 1060, y: 150 },
  { x: 1580, y: 150 },
  { x: 1580, y: 580 },
  { x: 1410, y: 580 },
  { x: 1410, y: 538 },
  { x: 1232, y: 538 },
  { x: 1232, y: 580 },
  { x: 1060, y: 580 },
];

const depotOutline: Vec2[] = [
  { x: 1820, y: 220 },
  { x: 2230, y: 220 },
  { x: 2230, y: 740 },
  { x: 1970, y: 740 },
  { x: 1970, y: 686 },
  { x: 1820, y: 686 },
];

const annexOutline: Vec2[] = [
  { x: 270, y: 850 },
  { x: 740, y: 850 },
  { x: 740, y: 1150 },
  { x: 612, y: 1150 },
  { x: 612, y: 1112 },
  { x: 270, y: 1112 },
];

const stationOutline: Vec2[] = [
  { x: 1040, y: 960 },
  { x: 1600, y: 960 },
  { x: 1600, y: 1210 },
  { x: 1490, y: 1210 },
  { x: 1490, y: 1164 },
  { x: 1040, y: 1164 },
];

const labsOutline: Vec2[] = [
  { x: 1850, y: 980 },
  { x: 2210, y: 980 },
  { x: 2210, y: 1290 },
  { x: 2075, y: 1290 },
  { x: 2075, y: 1238 },
  { x: 1850, y: 1238 },
];

const cityBuildings: BuildingFootprint[] = [
  {
    id: "clinic",
    label: "MERCY CLINIC",
    x: 240,
    y: 180,
    w: 560,
    h: 360,
    outline: clinicOutline,
    entry: { x: 520, y: 540 },
    windowSpecs: [
      { id: "clinic-window-n1", edge: 0, start: 118, size: 92 },
      { id: "clinic-window-n2", edge: 0, start: 330, size: 112 },
      { id: "clinic-window-e1", edge: 1, start: 145, size: 84 },
      { id: "clinic-window-s1", edge: 2, start: 50, size: 82 },
      { id: "clinic-window-w1", edge: 7, start: 112, size: 86 },
    ],
  },
  {
    id: "arcade",
    label: "NORTH ARCADE",
    x: 1060,
    y: 150,
    w: 520,
    h: 430,
    outline: arcadeOutline,
    entry: { x: 1320, y: 580 },
    windowSpecs: [
      { id: "arcade-window-n1", edge: 0, start: 82, size: 96 },
      { id: "arcade-window-n2", edge: 0, start: 335, size: 96 },
      { id: "arcade-window-e1", edge: 1, start: 145, size: 96 },
      { id: "arcade-window-s1", edge: 2, start: 42, size: 82 },
      { id: "arcade-window-w1", edge: 7, start: 235, size: 78 },
    ],
  },
  {
    id: "depot",
    label: "LOT 6 DEPOT",
    x: 1820,
    y: 220,
    w: 410,
    h: 520,
    outline: depotOutline,
    entry: { x: 1820, y: 500 },
    windowSpecs: [
      { id: "depot-window-n1", edge: 0, start: 92, size: 78 },
      { id: "depot-window-n2", edge: 0, start: 260, size: 72 },
      { id: "depot-window-e1", edge: 1, start: 172, size: 118 },
      { id: "depot-window-s1", edge: 2, start: 108, size: 84 },
    ],
  },
  {
    id: "annex",
    label: "CIVIC ANNEX",
    x: 270,
    y: 850,
    w: 470,
    h: 300,
    outline: annexOutline,
    windowSpecs: [
      { id: "annex-window-n1", edge: 0, start: 95, size: 96 },
      { id: "annex-window-n2", edge: 0, start: 270, size: 96 },
      { id: "annex-window-w1", edge: 5, start: 100, size: 74 },
    ],
  },
  {
    id: "station",
    label: "TRANSIT HALL",
    x: 1040,
    y: 960,
    w: 560,
    h: 250,
    outline: stationOutline,
    entry: { x: 1260, y: 1164 },
    windowSpecs: [
      { id: "station-window-n1", edge: 0, start: 82, size: 122 },
      { id: "station-window-n2", edge: 0, start: 330, size: 122 },
      { id: "station-window-e1", edge: 1, start: 60, size: 74 },
      { id: "station-window-s1", edge: 4, start: 60, size: 96 },
      { id: "station-window-s2", edge: 4, start: 260, size: 96 },
    ],
  },
  {
    id: "labs",
    label: "OLD LABS",
    x: 1850,
    y: 980,
    w: 360,
    h: 310,
    outline: labsOutline,
    windowSpecs: [
      { id: "labs-window-n1", edge: 0, start: 68, size: 82 },
      { id: "labs-window-n2", edge: 0, start: 220, size: 78 },
      { id: "labs-window-e1", edge: 1, start: 90, size: 92 },
      { id: "labs-window-s1", edge: 4, start: 70, size: 86 },
    ],
  },
];

const cityPlants: Plant[] = [
  { id: "tree-1", kind: "tree", x: 170, y: 500, radius: 18 },
  { id: "tree-2", kind: "tree", x: 700, y: 500, radius: 17 },
  { id: "tree-3", kind: "tree", x: 1040, y: 820, radius: 19 },
  { id: "tree-4", kind: "tree", x: 1550, y: 820, radius: 17 },
  { id: "tree-5", kind: "tree", x: 2240, y: 850, radius: 18 },
  { id: "tree-6", kind: "tree", x: 1960, y: 1380, radius: 20 },
  { id: "shrub-1", kind: "shrub", x: 1180, y: 875, radius: 14 },
  { id: "shrub-2", kind: "shrub", x: 1285, y: 875, radius: 13 },
  { id: "shrub-3", kind: "shrub", x: 1390, y: 875, radius: 13 },
  { id: "planter-1", kind: "planter", x: 1010, y: 1130, radius: 16 },
  { id: "planter-2", kind: "planter", x: 1590, y: 1130, radius: 16 },
  { id: "planter-3", kind: "planter", x: 1160, y: 1010, radius: 14 },
  { id: "planter-4", kind: "planter", x: 1528, y: 1006, radius: 14 },
  { id: "shrub-4", kind: "shrub", x: 1128, y: 1368, radius: 12 },
  { id: "shrub-5", kind: "shrub", x: 1228, y: 1368, radius: 12 },
  { id: "shrub-6", kind: "shrub", x: 1328, y: 1368, radius: 12 },
  { id: "shrub-7", kind: "shrub", x: 1428, y: 1368, radius: 12 },
  { id: "lamp-1", kind: "lamp", x: 1040, y: 650, radius: 11 },
  { id: "lamp-2", kind: "lamp", x: 1540, y: 650, radius: 11 },
  { id: "lamp-3", kind: "lamp", x: 1040, y: 1235, radius: 11 },
  { id: "lamp-4", kind: "lamp", x: 1540, y: 1235, radius: 11 },
];

const cityFixtures: StreetFixture[] = [
  { id: "station-cover-nw", kind: "utility-cover", x: 1038, y: 1110, radius: 9 },
  { id: "station-cover-ne", kind: "utility-cover", x: 1542, y: 1110, radius: 9 },
  { id: "station-cover-sw", kind: "utility-cover", x: 1038, y: 1238, radius: 9 },
  { id: "station-cover-se", kind: "utility-cover", x: 1542, y: 1238, radius: 9 },
  { id: "crossing-bollard-1", kind: "bollard", x: 1156, y: 1348, radius: 6 },
  { id: "crossing-bollard-2", kind: "bollard", x: 1248, y: 1348, radius: 6 },
  { id: "crossing-bollard-3", kind: "bollard", x: 1340, y: 1348, radius: 6 },
  { id: "crossing-bollard-4", kind: "bollard", x: 1432, y: 1348, radius: 6 },
  { id: "extract-sign", kind: "sign", x: 1608, y: 1328, radius: 8 },
  { id: "arcade-cover-west", kind: "utility-cover", x: 1042, y: 642, radius: 8 },
  { id: "arcade-cover-east", kind: "utility-cover", x: 1538, y: 642, radius: 8 },
  { id: "labs-cover-south", kind: "utility-cover", x: 1972, y: 1376, radius: 9 },
];

const cityExtractionZones: ExtractionZone[] = [
  { id: "station-extract", x: 1310, y: 1316, w: 300, h: 176, radius: 18, arrow: "up" },
  { id: "lot-extract", x: 2035, y: 1265, w: 230, h: 150, radius: 18, arrow: "right" },
];

const cityLinework: DetailLine[] = [
  { id: "clinic-room-a", x1: 340, y1: 245, x2: 700, y2: 245, alpha: 0.38 },
  { id: "clinic-room-b", x1: 520, y1: 180, x2: 520, y2: 500, alpha: 0.38 },
  { id: "clinic-room-c", x1: 340, y1: 360, x2: 610, y2: 360, alpha: 0.3 },
  { id: "clinic-counter-line", x1: 654, y1: 318, x2: 760, y2: 318, alpha: 0.28 },
  { id: "clinic-hall-a", x1: 284, y1: 470, x2: 610, y2: 470, alpha: 0.22 },
  { id: "clinic-hall-b", x1: 720, y1: 245, x2: 720, y2: 500, alpha: 0.2 },
  { id: "arcade-room-a", x1: 1160, y1: 260, x2: 1488, y2: 260, alpha: 0.34 },
  { id: "arcade-room-b", x1: 1320, y1: 150, x2: 1320, y2: 538, alpha: 0.34 },
  { id: "arcade-room-c", x1: 1125, y1: 420, x2: 1515, y2: 420, alpha: 0.28 },
  { id: "arcade-display-line-a", x1: 1120, y1: 314, x2: 1248, y2: 314, alpha: 0.2 },
  { id: "arcade-display-line-b", x1: 1392, y1: 314, x2: 1532, y2: 314, alpha: 0.2 },
  { id: "depot-room-a", x1: 1965, y1: 336, x2: 2220, y2: 336, alpha: 0.32 },
  { id: "depot-room-b", x1: 1965, y1: 530, x2: 1965, y2: 735, alpha: 0.32 },
  { id: "annex-room-a", x1: 362, y1: 850, x2: 362, y2: 1112, alpha: 0.3 },
  { id: "annex-room-b", x1: 270, y1: 1002, x2: 612, y2: 1002, alpha: 0.3 },
  { id: "station-room-a", x1: 1188, y1: 960, x2: 1188, y2: 1164, alpha: 0.32 },
  { id: "station-room-b", x1: 1410, y1: 960, x2: 1410, y2: 1164, alpha: 0.32 },
  { id: "station-south-service-line", x1: 1072, y1: 1144, x2: 1440, y2: 1144, alpha: 0.2 },
  { id: "station-lobby-axis", x1: 1040, y1: 1062, x2: 1600, y2: 1062, alpha: 0.16 },
  { id: "station-ticket-aisle", x1: 1265, y1: 980, x2: 1265, y2: 1142, alpha: 0.18 },
  { id: "station-right-utility-line", x1: 1510, y1: 980, x2: 1510, y2: 1164, alpha: 0.2 },
  { id: "labs-room-a", x1: 1960, y1: 980, x2: 1960, y2: 1238, alpha: 0.3 },
  { id: "labs-room-b", x1: 1850, y1: 1110, x2: 2075, y2: 1110, alpha: 0.3 },
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `lower-lot-stall-${index}`,
    x1: 1840 + index * 30,
    y1: 1320,
    x2: 1840 + index * 30,
    y2: 1418,
    alpha: 0.24,
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    id: `west-lot-stall-${index}`,
    x1: 332 + index * 62,
    y1: 1160,
    x2: 332 + index * 62,
    y2: 1270,
    alpha: 0.2,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    id: `planter-strip-${index}`,
    x1: 1170 + index * 82,
    y1: 1396,
    x2: 1225 + index * 82,
    y2: 1396,
    alpha: 0.28,
  })),
];

const cityDecals: FloorDecal[] = [
  { id: "station-ticket-counter-a", kind: "counter-run", x: 1208, y: 1002, w: 116, h: 24, cells: 4, alpha: 0.78 },
  { id: "station-ticket-counter-b", kind: "counter-run", x: 1460, y: 1002, w: 118, h: 24, cells: 4, alpha: 0.78 },
  { id: "station-service-panel", kind: "panel-grid", x: 1510, y: 1094, w: 54, h: 38, cells: 3, alpha: 0.78 },
  { id: "station-chair-row-a", kind: "chair-row", x: 1348, y: 1054, w: 92, h: 28, cells: 4, alpha: 0.82 },
  { id: "station-chair-row-b", kind: "chair-row", x: 1350, y: 1120, w: 96, h: 28, cells: 4, alpha: 0.78 },
  { id: "station-fixture-row-a", kind: "fixture-row", x: 1080, y: 1040, w: 36, h: 92, cells: 4, alpha: 0.72 },
  { id: "station-fixture-row-b", kind: "fixture-row", x: 1555, y: 1032, w: 82, h: 26, cells: 4, alpha: 0.68 },
  { id: "station-utility-hatch", kind: "hatch-box", x: 1152, y: 1120, w: 42, h: 42, alpha: 0.76 },
  { id: "station-floor-register", kind: "thin-rect", x: 1270, y: 1138, w: 74, h: 18, cells: 4, alpha: 0.44 },
  { id: "station-entry-stairs", kind: "entry-stairs", x: 1272, y: 1142, w: 82, h: 34, arrow: "down", alpha: 0.86 },
  { id: "station-sidewalk-box", kind: "panel-grid", x: 1486, y: 910, w: 82, h: 28, cells: 4, alpha: 0.62 },
  { id: "station-north-pavers", kind: "paver-row", x: 1296, y: 876, w: 420, h: 44, cells: 10, alpha: 0.34 },
  { id: "station-south-pavers", kind: "paver-row", x: 1300, y: 1328, w: 390, h: 48, cells: 9, alpha: 0.32 },
  { id: "station-lower-parking-row", kind: "parking-row", x: 1188, y: 1358, w: 332, h: 78, cells: 5, alpha: 0.34 },
  { id: "labs-lower-parking-row", kind: "parking-row", x: 2038, y: 1350, w: 282, h: 90, cells: 4, alpha: 0.28 },
  { id: "arcade-street-pavers", kind: "paver-row", x: 1310, y: 644, w: 400, h: 42, cells: 9, alpha: 0.28 },
  { id: "arcade-floor-hatch", kind: "hatch-box", x: 1170, y: 520, w: 46, h: 46, alpha: 0.66 },
  { id: "clinic-service-panel", kind: "counter-run", x: 690, y: 342, w: 78, h: 24, cells: 3, alpha: 0.66 },
  { id: "labs-floor-hatch-a", kind: "hatch-box", x: 1980, y: 1070, w: 50, h: 50, alpha: 0.72 },
  { id: "labs-floor-hatch-b", kind: "hatch-box", x: 2055, y: 1150, w: 50, h: 50, alpha: 0.72 },
  { id: "labs-counter-grid", kind: "panel-grid", x: 2118, y: 1012, w: 70, h: 34, cells: 3, alpha: 0.66 },
  { id: "lower-planter-bed-a", kind: "thin-rect", x: 1126, y: 1360, w: 420, h: 72, cells: 5, alpha: 0.38 },
  { id: "west-lot-hatch", kind: "hatch-box", x: 486, y: 1128, w: 56, h: 56, alpha: 0.56 },
];

const cityRooms: RoomOutline[] = [
  {
    id: "clinic-waiting-room",
    x: 278,
    y: 222,
    w: 216,
    h: 138,
    gaps: [{ side: "right", start: 48, size: 42 }],
    alpha: 0.36,
  },
  {
    id: "clinic-front-office",
    x: 506,
    y: 222,
    w: 254,
    h: 118,
    gaps: [{ side: "bottom", start: 90, size: 52 }],
    alpha: 0.36,
  },
  {
    id: "clinic-treatment-room",
    x: 506,
    y: 358,
    w: 254,
    h: 128,
    gaps: [{ side: "left", start: 38, size: 44 }],
    alpha: 0.38,
  },
  {
    id: "depot-front-room",
    x: 1872,
    y: 274,
    w: 160,
    h: 164,
    gaps: [{ side: "right", start: 62, size: 44 }],
    alpha: 0.34,
  },
  {
    id: "depot-stock-room",
    x: 2044,
    y: 274,
    w: 146,
    h: 164,
    gaps: [{ side: "bottom", start: 48, size: 44 }],
    alpha: 0.34,
  },
  {
    id: "depot-bay-room",
    x: 1872,
    y: 456,
    w: 256,
    h: 190,
    gaps: [{ side: "left", start: 72, size: 54 }],
    alpha: 0.32,
  },
  {
    id: "annex-sleep-room",
    x: 304,
    y: 884,
    w: 160,
    h: 106,
    gaps: [{ side: "right", start: 36, size: 42 }],
    alpha: 0.34,
  },
  {
    id: "annex-dining-room",
    x: 488,
    y: 884,
    w: 204,
    h: 106,
    gaps: [{ side: "bottom", start: 70, size: 48 }],
    alpha: 0.34,
  },
  {
    id: "annex-garage-room",
    x: 304,
    y: 1006,
    w: 326,
    h: 92,
    gaps: [{ side: "top", start: 150, size: 54 }],
    alpha: 0.32,
  },
  {
    id: "station-left-service-room",
    x: 1088,
    y: 988,
    w: 135,
    h: 170,
    gaps: [{ side: "right", start: 68, size: 46 }],
    alpha: 0.44,
  },
  {
    id: "station-ticket-room",
    x: 1222,
    y: 988,
    w: 214,
    h: 72,
    gaps: [{ side: "bottom", start: 78, size: 52 }],
    alpha: 0.38,
  },
  {
    id: "station-office-room",
    x: 1436,
    y: 988,
    w: 138,
    h: 118,
    gaps: [{ side: "left", start: 44, size: 42 }],
    alpha: 0.42,
  },
  {
    id: "station-storage-room",
    x: 1492,
    y: 1080,
    w: 82,
    h: 90,
    gaps: [{ side: "left", start: 25, size: 34 }],
    alpha: 0.44,
  },
  {
    id: "arcade-kitchen-room",
    x: 1090,
    y: 230,
    w: 162,
    h: 156,
    gaps: [{ side: "right", start: 58, size: 42 }],
    alpha: 0.34,
  },
  {
    id: "labs-exam-room",
    x: 1876,
    y: 1012,
    w: 150,
    h: 116,
    gaps: [{ side: "right", start: 40, size: 42 }],
    alpha: 0.38,
  },
  {
    id: "labs-storage-room",
    x: 2030,
    y: 1128,
    w: 142,
    h: 104,
    gaps: [{ side: "left", start: 30, size: 40 }],
    alpha: 0.38,
  },
];

const cityWindows: WindowSlot[] = [
  ...cityBuildings.flatMap((building) =>
    building.outline && building.windowSpecs ? outlineWindowSlots(building.outline, building.windowSpecs) : [],
  ),
];

const cityDoors: DoorSwing[] = [
  { id: "clinic-entry-door", x: 484, y: 500, radius: 38, start: 0, end: Math.PI / 2 },
  { id: "clinic-room-door", x: 610, y: 360, radius: 34, start: Math.PI, end: Math.PI * 1.5 },
  { id: "arcade-entry-door", x: 1268, y: 538, radius: 36, start: -Math.PI / 2, end: 0 },
  { id: "arcade-room-door", x: 1405, y: 420, radius: 34, start: Math.PI, end: Math.PI * 1.5 },
  { id: "depot-entry-door", x: 1820, y: 454, radius: 40, start: 0, end: Math.PI / 2 },
  { id: "annex-room-door", x: 362, y: 1002, radius: 32, start: -Math.PI / 2, end: 0 },
  { id: "station-room-door", x: 1188, y: 1070, radius: 32, start: 0, end: Math.PI / 2 },
  { id: "labs-room-door", x: 1960, y: 1110, radius: 32, start: Math.PI, end: Math.PI * 1.5 },
];

const clinicShell = outlineWalls(clinicOutline, [{ edge: 4, start: 64, size: 72 }]);
const arcadeShell = outlineWalls(arcadeOutline, [{ edge: 4, start: 53, size: 72 }]);
const depotShell = outlineWalls(depotOutline, [{ edge: 5, start: 134, size: 108 }]);
const annexShell = outlineWalls(annexOutline);
const stationShell = outlineWalls(stationOutline, [{ edge: 4, start: 205, size: 110 }]);
const labsShell = outlineWalls(labsOutline);

const stationInteriorWalls: Wall[] = [
  { x: 1168, y: 960, w: 14, h: 70 },
  { x: 1168, y: 1092, w: 14, h: 72 },
  { x: 1040, y: 1060, w: 100, h: 12 },
  { x: 1440, y: 960, w: 14, h: 74 },
  { x: 1440, y: 1112, w: 14, h: 52 },
  { x: 1518, y: 1090, w: 82, h: 12 },
];

const labsInteriorWalls: Wall[] = [
  { x: 1960, y: 980, w: 14, h: 95 },
  { x: 1960, y: 1140, w: 14, h: 98 },
  { x: 1850, y: 1110, w: 94, h: 12 },
  { x: 2035, y: 1110, w: 40, h: 12 },
];

const BASE_FLOORS: Record<FloorId, FloorConfig> = {
  ground: {
    id: "ground",
    label: "LOWER CITY / STREET",
    camera: { x: 0, y: 0, w: MAP_W, h: MAP_H },
    roads: cityRoads,
    sidewalks: citySidewalks,
    curbs: cityCurbs,
    patches: cityPatches,
    crosswalks: cityCrosswalks,
    plants: cityPlants,
    fixtures: cityFixtures,
    buildings: cityBuildings,
    windows: cityWindows,
    linework: cityLinework,
    decals: cityDecals,
    rooms: cityRooms,
    doors: cityDoors,
    extractionZones: cityExtractionZones,
    walls: [
      ...boundsWalls(),
      ...clinicShell,
      ...arcadeShell,
      ...depotShell,
      ...annexShell,
      ...stationShell,
      ...labsShell,
      ...labsInteriorWalls,
    ],
    dots: cloneDots([
      { id: "dot-dash-street", type: "dash", x: 900, y: 820, radius: 10, captureMs: 1600 },
      { id: "dot-regen-plaza", type: "regen", x: 1285, y: 900, radius: 10, captureMs: 1900 },
      { id: "dot-scanner-crossing", type: "scanner", x: 1715, y: 850, radius: 10, captureMs: 2200 },
      { id: "dot-decoy-extract", type: "decoy", x: 2135, y: 1345, radius: 10, captureMs: 1900 },
      { id: "dot-shield-sidewalk", type: "shield", x: 580, y: 770, radius: 10, captureMs: 2100 },
    ]),
    objects: cloneObjects([
      { id: "clinic-wait-sofa-1", kind: "sofa", x: 330, y: 294, rotation: 0, scannable: true, scanMs: 2600 },
      { id: "clinic-wait-chair-1", kind: "armchair", x: 450, y: 292, scannable: true, scanMs: 1800 },
      { id: "clinic-front-counter-1", kind: "counter", x: 682, y: 270, scannable: true, scanMs: 2200 },
      { id: "clinic-cot-ground", kind: "medical-cot", x: 682, y: 442, rotation: 0, scannable: true, scanMs: 3000 },
      { id: "clinic-washroom-ground", kind: "washroom", x: 500, y: 430, scannable: true, scanMs: 2400 },
      { id: "clinic-file-1", kind: "file-cabinet", x: 760, y: 360, rotation: 90, scannable: true, scanMs: 2200 },
      { id: "arcade-kitchen-1", kind: "kitchen-island", x: 1180, y: 302, scannable: true, scanMs: 2600 },
      { id: "arcade-shelf-ground-1", kind: "shelf", x: 1490, y: 306, rotation: 0, scannable: true, scanMs: 2600 },
      { id: "arcade-armchair-1", kind: "armchair", x: 1456, y: 492, scannable: true, scanMs: 1800 },
      { id: "arcade-vending-ground-1", kind: "vending-machine", x: 1120, y: 522, scannable: true, scanMs: 2400 },
      { id: "street-bench-1", kind: "bench", x: 375, y: 785, rotation: 0, scannable: true, scanMs: 1800 },
      { id: "street-bench-2", kind: "bench", x: 1495, y: 880, rotation: 0, scannable: true, scanMs: 1800 },
      { id: "street-bench-3", kind: "bench", x: 1148, y: 550, rotation: 0, scannable: true, scanMs: 1800 },
      { id: "street-bench-4", kind: "bench", x: 1438, y: 550, rotation: 0, scannable: true, scanMs: 1800 },
      { id: "annex-crate-1", kind: "crate", x: 700, y: 1180, scannable: false, scanMs: 0 },
      { id: "annex-bed-1", kind: "bed", x: 472, y: 918, rotation: 90, scannable: true, scanMs: 2800 },
      { id: "annex-table-1", kind: "dining-table", x: 610, y: 930, rotation: 90, scannable: true, scanMs: 2200 },
      { id: "annex-car-1", kind: "car", x: 455, y: 1035, rotation: 90, scannable: false, scanMs: 0 },
      { id: "annex-car-2", kind: "car", x: 565, y: 1035, rotation: 90, scannable: false, scanMs: 0 },
      { id: "labs-crate-1", kind: "crate", x: 1955, y: 1098, scannable: true, scanMs: 2200 },
      { id: "labs-crate-2", kind: "crate", x: 2035, y: 1175, scannable: false, scanMs: 0 },
      { id: "labs-shelf-1", kind: "shelf", x: 2142, y: 1048, rotation: 90, scannable: true, scanMs: 2600 },
      { id: "labs-bed-1", kind: "bed", x: 1898, y: 1185, rotation: 90, scannable: true, scanMs: 2800 },
      { id: "labs-washroom-1", kind: "washroom", x: 2042, y: 1040, scannable: true, scanMs: 2400 },
      { id: "labs-car-1", kind: "car", x: 2050, y: 1188, rotation: 90, scannable: false, scanMs: 0 },
      { id: "extract-crate-1", kind: "crate", x: 2135, y: 1255, scannable: true, scanMs: 2400 },
    ]),
    stairs: [
      {
        id: "entry-clinic",
        label: "Clinic Entry",
        x: 520,
        y: 548,
        w: 108,
        h: 30,
        visual: "entry",
        toFloor: "clinic-ground",
        toPosition: { x: 520, y: 493 },
      },
      {
        id: "entry-arcade",
        label: "Arcade Entry",
        x: 1320,
        y: 588,
        w: 132,
        h: 30,
        visual: "entry",
        toFloor: "arcade-ground",
        toPosition: { x: 1320, y: 522 },
      },
      {
        id: "entry-station",
        label: "Transit Hall Entry",
        x: 1260,
        y: 1206,
        w: 126,
        h: 32,
        visual: "entry",
        toFloor: "station-ground",
        toPosition: { x: 1260, y: 1088 },
      },
      {
        id: "entry-depot",
        label: "Depot Entry",
        x: 1810,
        y: 500,
        w: 30,
        h: 122,
        visual: "entry",
        toFloor: "depot-ground",
        toPosition: { x: 1885, y: 500 },
      },
    ],
    labels: [
      { text: "MERCY CLINIC", x: 278, y: 150, size: 13 },
      { text: "NORTH ARCADE", x: 1090, y: 120, size: 13 },
      { text: "LOT 6 DEPOT", x: 1865, y: 190, size: 13 },
      { text: "CIVIC ANNEX", x: 305, y: 820, size: 12 },
      { text: "TRANSIT HALL", x: 1082, y: 930, size: 12 },
      { text: "OLD LABS", x: 1908, y: 950, size: 12 },
      { text: "EXTRACT", x: 2078, y: 1398, size: 12 },
    ],
  },
  "station-ground": {
    id: "station-ground",
    label: "TRANSIT HALL / GROUND",
    camera: { x: 930, y: 860, w: 800, h: 470 },
    area: { x: 1040, y: 960, w: 560, h: 250 },
    walls: [
      ...stationShell,
      ...stationInteriorWalls,
    ],
    dots: cloneDots([
      { id: "dot-dash-station", type: "dash", x: 1340, y: 1070, radius: 10, captureMs: 1700 },
      { id: "dot-scanner-station", type: "scanner", x: 1120, y: 1118, radius: 10, captureMs: 2300 },
      { id: "dot-shield-station", type: "shield", x: 1538, y: 1016, radius: 10, captureMs: 2200 },
    ]),
    objects: cloneObjects([
      { id: "station-table-1", kind: "dining-table", x: 1340, y: 1088, scannable: true, scanMs: 2200 },
      { id: "station-desk-1", kind: "desk", x: 1490, y: 1068, scannable: true, scanMs: 2400 },
      { id: "station-sofa-1", kind: "sofa", x: 1538, y: 1125, rotation: 90, scannable: true, scanMs: 2600 },
      { id: "station-plaza-table-1", kind: "table", x: 1210, y: 1015, scannable: true, scanMs: 2200 },
      { id: "station-plaza-planter-1", kind: "plant-bed", x: 1395, y: 1018, scannable: true, scanMs: 2000 },
      { id: "station-kitchen-1", kind: "kitchen-island", x: 1115, y: 1030, rotation: 90, scannable: true, scanMs: 2600 },
      { id: "station-vending-1", kind: "vending-machine", x: 1584, y: 1042, rotation: 90, scannable: true, scanMs: 2400 },
      { id: "station-armchair-1", kind: "armchair", x: 1215, y: 1130, scannable: true, scanMs: 1800 },
    ]),
    stairs: [
      {
        id: "exit-station-ground",
        label: "Street",
        x: 1260,
        y: 1146,
        w: 126,
        h: 32,
        visual: "entry",
        toFloor: "ground",
        toPosition: { x: 1260, y: 1240 },
      },
    ],
    labels: [{ text: "TRANSIT HALL / GROUND", x: 1082, y: 930, size: 12 }],
  },
  "clinic-ground": {
    id: "clinic-ground",
    label: "MERCY CLINIC / GROUND",
    camera: { x: 110, y: 70, w: 840, h: 630 },
    area: { x: 240, y: 180, w: 560, h: 360 },
    walls: [
      ...shellWalls(240, 180, 560, 360, [{ side: "bottom", start: 235, size: 90 }]),
      { x: 420, y: 180, w: 16, h: 250 },
      { x: 420, y: 488, w: 16, h: 52 },
      { x: 610, y: 180, w: 16, h: 120 },
      { x: 610, y: 370, w: 16, h: 170 },
      { x: 240, y: 342, w: 180, h: 14 },
      { x: 610, y: 300, w: 190, h: 14 },
    ],
    windows: [
      { id: "clinic-ground-window-n1", x: 330, y: 178, w: 84, h: 6 },
      { id: "clinic-ground-window-n2", x: 640, y: 178, w: 82, h: 6 },
      { id: "clinic-ground-window-e1", x: 798, y: 392, w: 6, h: 72 },
    ],
    linework: [
      { id: "clinic-ground-cabinet-1", x1: 258, y1: 268, x2: 402, y2: 268, alpha: 0.26 },
      { id: "clinic-ground-cabinet-2", x1: 640, y1: 252, x2: 772, y2: 252, alpha: 0.26 },
      { id: "clinic-ground-room-line", x1: 610, y1: 420, x2: 800, y2: 420, alpha: 0.24 },
    ],
    doors: [
      { id: "clinic-ground-exam-door", x: 420, y: 342, radius: 34, start: 0, end: Math.PI / 2 },
      { id: "clinic-ground-office-door", x: 610, y: 300, radius: 34, start: Math.PI / 2, end: Math.PI },
      { id: "clinic-ground-entry-door", x: 484, y: 540, radius: 38, start: -Math.PI / 2, end: 0 },
    ],
    dots: cloneDots([
      { id: "dot-regen-clinic", type: "regen", x: 332, y: 278, radius: 10, captureMs: 1900 },
      { id: "dot-shield-clinic", type: "shield", x: 702, y: 436, radius: 10, captureMs: 2200 },
    ]),
    objects: cloneObjects([
      { id: "clinic-desk-1", kind: "counter", x: 520, y: 438, scannable: true, scanMs: 2200 },
      { id: "clinic-cot-1", kind: "medical-cot", x: 335, y: 445, rotation: 0, scannable: true, scanMs: 3000 },
      { id: "clinic-locker-1", kind: "locker", x: 708, y: 244, scannable: true, scanMs: 2600 },
      { id: "clinic-plant-1", kind: "plant-bed", x: 300, y: 235, scannable: false, scanMs: 0 },
    ]),
    stairs: [
      {
        id: "exit-clinic-ground",
        label: "Street",
        x: 520,
        y: 548,
        w: 108,
        h: 30,
        visual: "entry",
        toFloor: "ground",
        toPosition: { x: 520, y: 590 },
      },
      {
        id: "stairs-clinic-up",
        label: "F2",
        x: 726,
        y: 266,
        w: 64,
        h: 72,
        toFloor: "clinic-f2",
        toPosition: { x: 724, y: 308 },
      },
    ],
    labels: [{ text: "MERCY CLINIC / GROUND", x: 265, y: 150, size: 13 }],
  },
  "clinic-f2": {
    id: "clinic-f2",
    label: "MERCY CLINIC / F2",
    camera: { x: 110, y: 70, w: 840, h: 630 },
    area: { x: 240, y: 180, w: 560, h: 360 },
    walls: [
      ...shellWalls(240, 180, 560, 360),
      { x: 405, y: 180, w: 16, h: 255 },
      { x: 585, y: 180, w: 16, h: 160 },
      { x: 585, y: 410, w: 16, h: 130 },
      { x: 240, y: 350, w: 165, h: 14 },
      { x: 585, y: 338, w: 215, h: 14 },
    ],
    windows: [
      { id: "clinic-f2-window-n1", x: 300, y: 178, w: 82, h: 6 },
      { id: "clinic-f2-window-n2", x: 640, y: 178, w: 104, h: 6 },
      { id: "clinic-f2-window-w1", x: 238, y: 430, w: 6, h: 68 },
    ],
    linework: [
      { id: "clinic-f2-room-a", x1: 405, y1: 435, x2: 585, y2: 435, alpha: 0.26 },
      { id: "clinic-f2-room-b", x1: 602, y1: 456, x2: 780, y2: 456, alpha: 0.22 },
      { id: "clinic-f2-room-c", x1: 432, y1: 265, x2: 565, y2: 265, alpha: 0.22 },
    ],
    doors: [
      { id: "clinic-f2-room-door-a", x: 405, y: 350, radius: 32, start: 0, end: Math.PI / 2 },
      { id: "clinic-f2-room-door-b", x: 585, y: 410, radius: 32, start: Math.PI, end: Math.PI * 1.5 },
    ],
    dots: cloneDots([
      { id: "dot-shield-clinic-f2", type: "shield", x: 332, y: 255, radius: 10, captureMs: 2100 },
      { id: "dot-damage-clinic-f2", type: "damage", x: 700, y: 430, radius: 10, captureMs: 2500 },
      { id: "dot-regen-clinic-f2", type: "regen", x: 502, y: 246, radius: 10, captureMs: 2100 },
    ]),
    objects: cloneObjects([
      { id: "clinic-cot-2", kind: "medical-cot", x: 335, y: 430, scannable: true, scanMs: 3000 },
      { id: "clinic-cot-3", kind: "medical-cot", x: 505, y: 454, rotation: 90, scannable: true, scanMs: 3000 },
      { id: "clinic-desk-2", kind: "desk", x: 696, y: 246, scannable: true, scanMs: 2400 },
      { id: "clinic-shelf-1", kind: "shelf", x: 705, y: 488, scannable: false, scanMs: 0 },
    ]),
    stairs: [
      {
        id: "stairs-clinic-down",
        label: "Ground",
        x: 724,
        y: 308,
        w: 64,
        h: 72,
        toFloor: "clinic-ground",
        toPosition: { x: 726, y: 266 },
      },
    ],
    labels: [{ text: "MERCY CLINIC / F2", x: 265, y: 150, size: 13 }],
  },
  "arcade-ground": {
    id: "arcade-ground",
    label: "NORTH ARCADE / GROUND",
    camera: { x: 930, y: 40, w: 820, h: 690 },
    area: { x: 1060, y: 150, w: 520, h: 430 },
    walls: [
      ...shellWalls(1060, 150, 520, 430, [{ side: "bottom", start: 205, size: 110 }]),
      { x: 1230, y: 150, w: 16, h: 150 },
      { x: 1230, y: 380, w: 16, h: 200 },
      { x: 1405, y: 150, w: 16, h: 200 },
      { x: 1405, y: 430, w: 16, h: 150 },
      { x: 1060, y: 350, w: 170, h: 14 },
      { x: 1405, y: 350, w: 55, h: 14 },
      { x: 1535, y: 350, w: 45, h: 14 },
    ],
    windows: [
      { id: "arcade-ground-window-n1", x: 1128, y: 148, w: 86, h: 6 },
      { id: "arcade-ground-window-n2", x: 1448, y: 148, w: 84, h: 6 },
      { id: "arcade-ground-window-e1", x: 1578, y: 410, w: 6, h: 72 },
    ],
    linework: [
      { id: "arcade-ground-display-1", x1: 1088, y1: 235, x2: 1212, y2: 235, alpha: 0.24 },
      { id: "arcade-ground-display-2", x1: 1438, y1: 236, x2: 1558, y2: 236, alpha: 0.24 },
      { id: "arcade-ground-display-3", x1: 1265, y1: 500, x2: 1380, y2: 500, alpha: 0.2 },
    ],
    doors: [
      { id: "arcade-ground-entry-door", x: 1268, y: 580, radius: 38, start: -Math.PI / 2, end: 0 },
      { id: "arcade-ground-room-door-a", x: 1230, y: 350, radius: 34, start: 0, end: Math.PI / 2 },
      { id: "arcade-ground-room-door-b", x: 1405, y: 350, radius: 34, start: Math.PI / 2, end: Math.PI },
    ],
    dots: cloneDots([
      { id: "dot-dash-arcade", type: "dash", x: 1165, y: 265, radius: 10, captureMs: 1700 },
      { id: "dot-decoy-arcade", type: "decoy", x: 1510, y: 262, radius: 10, captureMs: 2100 },
      { id: "dot-scanner-arcade", type: "scanner", x: 1320, y: 452, radius: 10, captureMs: 2200 },
    ]),
    objects: cloneObjects([
      { id: "arcade-counter-1", kind: "counter", x: 1144, y: 455, scannable: true, scanMs: 2200 },
      { id: "arcade-table-1", kind: "dining-table", x: 1320, y: 410, scannable: true, scanMs: 2200 },
      { id: "arcade-sofa-1", kind: "sofa", x: 1490, y: 455, scannable: true, scanMs: 2600 },
      { id: "arcade-planter-1", kind: "plant-bed", x: 1320, y: 525, scannable: false, scanMs: 0 },
    ]),
    stairs: [
      {
        id: "exit-arcade-ground",
        label: "Street",
        x: 1320,
        y: 588,
        w: 132,
        h: 30,
        visual: "entry",
        toFloor: "ground",
        toPosition: { x: 1320, y: 635 },
      },
      {
        id: "stairs-arcade-up",
        label: "F2",
        x: 1320,
        y: 262,
        w: 78,
        h: 70,
        toFloor: "arcade-f2",
        toPosition: { x: 1320, y: 365 },
      },
    ],
    labels: [{ text: "NORTH ARCADE / GROUND", x: 1085, y: 120, size: 13 }],
  },
  "arcade-f2": {
    id: "arcade-f2",
    label: "NORTH ARCADE / F2",
    camera: { x: 930, y: 40, w: 820, h: 690 },
    area: { x: 1060, y: 150, w: 520, h: 430 },
    walls: [
      ...shellWalls(1060, 150, 520, 430),
      { x: 1190, y: 150, w: 16, h: 170 },
      { x: 1430, y: 150, w: 16, h: 170 },
      { x: 1190, y: 410, w: 16, h: 170 },
      { x: 1430, y: 410, w: 16, h: 170 },
      { x: 1190, y: 320, w: 255, h: 14 },
      { x: 1190, y: 410, w: 255, h: 14 },
    ],
    windows: [
      { id: "arcade-f2-window-n1", x: 1104, y: 148, w: 90, h: 6 },
      { id: "arcade-f2-window-n2", x: 1452, y: 148, w: 90, h: 6 },
      { id: "arcade-f2-window-s1", x: 1258, y: 578, w: 124, h: 6 },
    ],
    linework: [
      { id: "arcade-f2-rail-1", x1: 1214, y1: 365, x2: 1420, y2: 365, alpha: 0.22 },
      { id: "arcade-f2-room-a", x1: 1060, y1: 236, x2: 1190, y2: 236, alpha: 0.22 },
      { id: "arcade-f2-room-b", x1: 1446, y1: 486, x2: 1580, y2: 486, alpha: 0.22 },
    ],
    doors: [
      { id: "arcade-f2-door-a", x: 1190, y: 320, radius: 34, start: 0, end: Math.PI / 2 },
      { id: "arcade-f2-door-b", x: 1430, y: 410, radius: 34, start: Math.PI, end: Math.PI * 1.5 },
    ],
    dots: cloneDots([
      { id: "dot-scanner-arcade-f2", type: "scanner", x: 1320, y: 365, radius: 10, captureMs: 2600 },
      { id: "dot-shield-arcade-f2", type: "shield", x: 1512, y: 484, radius: 10, captureMs: 2400 },
    ]),
    objects: cloneObjects([
      { id: "arcade-f2-shelf-1", kind: "shelf", x: 1135, y: 250, scannable: true, scanMs: 2600 },
      { id: "arcade-f2-bench-1", kind: "bench", x: 1320, y: 468, scannable: true, scanMs: 1800 },
      { id: "arcade-f2-counter-1", kind: "counter", x: 1510, y: 250, scannable: true, scanMs: 2400 },
    ]),
    stairs: [
      {
        id: "stairs-arcade-down",
        label: "Ground",
        x: 1320,
        y: 365,
        w: 78,
        h: 70,
        toFloor: "arcade-ground",
        toPosition: { x: 1320, y: 262 },
      },
    ],
    labels: [{ text: "NORTH ARCADE / F2", x: 1085, y: 120, size: 13 }],
  },
  "depot-ground": {
    id: "depot-ground",
    label: "LOT 6 DEPOT / GROUND",
    camera: { x: 1670, y: 70, w: 720, h: 800 },
    area: { x: 1820, y: 220, w: 410, h: 520 },
    walls: [
      ...shellWalls(1820, 220, 410, 520, [{ side: "left", start: 230, size: 100 }]),
      { x: 1960, y: 220, w: 16, h: 190 },
      { x: 1960, y: 500, w: 16, h: 240 },
      { x: 2095, y: 220, w: 16, h: 520 },
      { x: 1820, y: 420, w: 140, h: 14 },
      { x: 1960, y: 500, w: 135, h: 14 },
    ],
    windows: [
      { id: "depot-ground-window-n1", x: 1872, y: 218, w: 76, h: 6 },
      { id: "depot-ground-window-n2", x: 2128, y: 218, w: 62, h: 6 },
      { id: "depot-ground-window-e1", x: 2228, y: 448, w: 6, h: 110 },
    ],
    linework: [
      { id: "depot-ground-rack-line-1", x1: 2118, y1: 282, x2: 2118, y2: 390, alpha: 0.22 },
      { id: "depot-ground-rack-line-2", x1: 1995, y1: 600, x2: 2072, y2: 600, alpha: 0.24 },
      { id: "depot-ground-office-line", x1: 1820, y1: 560, x2: 1960, y2: 560, alpha: 0.22 },
    ],
    doors: [
      { id: "depot-ground-entry-door", x: 1820, y: 454, radius: 38, start: 0, end: Math.PI / 2 },
      { id: "depot-ground-office-door", x: 1960, y: 420, radius: 34, start: 0, end: Math.PI / 2 },
    ],
    dots: cloneDots([
      { id: "dot-damage-depot", type: "damage", x: 2155, y: 630, radius: 10, captureMs: 2700 },
      { id: "dot-shield-depot", type: "shield", x: 1905, y: 316, radius: 10, captureMs: 2300 },
    ]),
    objects: cloneObjects([
      { id: "depot-crate-1", kind: "crate", x: 1888, y: 610, scannable: true, scanMs: 2200 },
      { id: "depot-crate-2", kind: "crate", x: 2028, y: 626, scannable: false, scanMs: 0 },
      { id: "depot-shelf-1", kind: "shelf", x: 2160, y: 332, rotation: 90, scannable: true, scanMs: 2700 },
      { id: "depot-locker-1", kind: "locker", x: 1886, y: 292, scannable: true, scanMs: 2600 },
    ]),
    stairs: [
      {
        id: "exit-depot-ground",
        label: "Street",
        x: 1810,
        y: 500,
        w: 30,
        h: 122,
        visual: "entry",
        toFloor: "ground",
        toPosition: { x: 1760, y: 500 },
      },
      {
        id: "stairs-depot-down",
        label: "B1",
        x: 2156,
        y: 292,
        w: 70,
        h: 72,
        toFloor: "depot-b1",
        toPosition: { x: 2156, y: 360 },
      },
    ],
    labels: [{ text: "LOT 6 DEPOT / GROUND", x: 1854, y: 190, size: 13 }],
  },
  "depot-b1": {
    id: "depot-b1",
    label: "LOT 6 DEPOT / B1",
    camera: { x: 1670, y: 70, w: 720, h: 800 },
    area: { x: 1820, y: 220, w: 410, h: 520 },
    walls: [
      ...shellWalls(1820, 220, 410, 520),
      { x: 1950, y: 220, w: 16, h: 520 },
      { x: 2088, y: 220, w: 16, h: 190 },
      { x: 2088, y: 485, w: 16, h: 255 },
      { x: 1950, y: 410, w: 138, h: 14 },
      { x: 1950, y: 485, w: 138, h: 14 },
    ],
    linework: [
      { id: "depot-b1-rack-line-1", x1: 1838, y1: 274, x2: 1932, y2: 274, alpha: 0.24 },
      { id: "depot-b1-rack-line-2", x1: 1974, y1: 274, x2: 2070, y2: 274, alpha: 0.24 },
      { id: "depot-b1-storage-line", x1: 2112, y1: 565, x2: 2220, y2: 565, alpha: 0.22 },
    ],
    doors: [
      { id: "depot-b1-door-a", x: 1950, y: 410, radius: 34, start: 0, end: Math.PI / 2 },
      { id: "depot-b1-door-b", x: 2088, y: 485, radius: 34, start: Math.PI, end: Math.PI * 1.5 },
    ],
    dots: cloneDots([
      { id: "dot-damage-depot-b1", type: "damage", x: 1888, y: 630, radius: 10, captureMs: 3000 },
      { id: "dot-scanner-depot-b1", type: "scanner", x: 2156, y: 620, radius: 10, captureMs: 2800 },
    ]),
    objects: cloneObjects([
      { id: "depot-server-1", kind: "server-rack", x: 1884, y: 318, scannable: true, scanMs: 3200 },
      { id: "depot-server-2", kind: "server-rack", x: 2020, y: 318, scannable: true, scanMs: 3200 },
      { id: "depot-shelf-b1", kind: "shelf", x: 2164, y: 474, rotation: 90, scannable: true, scanMs: 2800 },
      { id: "depot-crate-b1", kind: "crate", x: 2028, y: 640, scannable: false, scanMs: 0 },
    ]),
    stairs: [
      {
        id: "stairs-depot-up",
        label: "Ground",
        x: 2156,
        y: 360,
        w: 70,
        h: 72,
        toFloor: "depot-ground",
        toPosition: { x: 2156, y: 292 },
      },
    ],
    labels: [{ text: "LOT 6 DEPOT / B1", x: 1854, y: 190, size: 13 }],
  },
};

const len = (v: Vec2) => Math.hypot(v.x, v.y);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const normalize = (v: Vec2): Vec2 => {
  const length = len(v);
  return length > 0.0001 ? { x: v.x / length, y: v.y / length } : { x: 0, y: 0 };
};

function freshFloor(id: FloorId): FloorConfig {
  const base = BASE_FLOORS[id];
  return {
    ...base,
    camera: { ...base.camera },
    area: base.area ? { ...base.area } : undefined,
    walls: base.walls.map((wall) => ({ ...wall })),
    dots: base.dots.map((dot) => ({ ...dot, capturedMs: 0 })),
    objects: base.objects.map((object) => ({
      ...object,
      scannedMs: 0,
      completed: false,
    })),
    stairs: base.stairs.map((stair) => ({ ...stair, toPosition: { ...stair.toPosition } })),
    roads: base.roads?.map((road) => ({ ...road })),
    sidewalks: base.sidewalks?.map((sidewalk) => ({ ...sidewalk })),
    curbs: base.curbs?.map((curb) => ({ ...curb })),
    patches: base.patches?.map((patch) => ({
      ...patch,
      dividers: patch.dividers ? [...patch.dividers] : undefined,
    })),
    crosswalks: base.crosswalks?.map((crosswalk) => ({ ...crosswalk })),
    plants: base.plants?.map((plant) => ({ ...plant })),
    fixtures: base.fixtures?.map((fixture) => ({ ...fixture })),
    buildings: base.buildings?.map((building) => ({
      ...building,
      outline: building.outline?.map((point) => ({ ...point })),
      entry: building.entry ? { ...building.entry } : undefined,
      windowSpecs: building.windowSpecs?.map((window) => ({ ...window })),
    })),
    windows: base.windows?.map((window) => ({ ...window })),
    linework: base.linework?.map((line) => ({ ...line })),
    decals: base.decals?.map((decal) => ({ ...decal })),
    rooms: base.rooms?.map((room) => ({
      ...room,
      gaps: room.gaps?.map((gap) => ({ ...gap })),
    })),
    doors: base.doors?.map((door) => ({ ...door })),
    extractionZones: base.extractionZones?.map((zone) => ({ ...zone })),
    labels: base.labels.map((label) => ({ ...label })),
  };
}

function createTestBots(): TestBot[] {
  return [
    {
      id: "enemy-alive",
      label: "Enemy",
      color: 0xf05252,
      x: 1488,
      y: 1018,
      vx: -72,
      vy: 34,
      radius: PLAYER_RADIUS,
      shields: 3,
      maxShields: 3,
      state: "alive",
      inventory: ["damage", "dash"],
      channelMs: 0,
      hitCooldownMs: 0,
      floor: "station-ground",
    },
    {
      id: "enemy-downed",
      label: "Downed Enemy",
      color: 0xf05252,
      x: 1518,
      y: 1134,
      vx: 0,
      vy: 0,
      radius: PLAYER_RADIUS,
      shields: 0,
      maxShields: 3,
      state: "downed",
      inventory: ["scanner", "damage"],
      channelMs: 0,
      hitCooldownMs: 0,
      floor: "station-ground",
    },
    {
      id: "teammate-downed",
      label: "Downed Teammate",
      color: 0x2f80ed,
      x: 1218,
      y: 1134,
      vx: 0,
      vy: 0,
      radius: PLAYER_RADIUS,
      shields: 0,
      maxShields: 3,
      state: "downed",
      inventory: [],
      channelMs: 0,
      hitCooldownMs: 0,
      floor: "station-ground",
    },
  ];
}

class DotBotGame {
  private app: Application;
  private rapier = RAPIER;
  private world: RAPIER.World;
  private playerBody: RAPIER.RigidBody;
  private controls: GameControls;
  private onHud: (hud: HudState) => void;
  private root = new Container();
  private mapLayer = new Graphics();
  private objectLayer = new Graphics();
  private dotLayer = new Graphics();
  private botLayer = new Graphics();
  private fxLayer = new Graphics();
  private labels = new Container();
  private floor: FloorConfig = freshFloor("ground");
  private colliders: RAPIER.Collider[] = [];
  private bots: TestBot[] = createTestBots();
  private inventory: DotType[] = ["dash", "regen"];
  private scans = 0;
  private shields = 3;
  private maxShields = 3;
  private dashMs = 0;
  private dashCooldownMs = 0;
  private repairCooldownMs = 0;
  private message = "Capture Dots by covering them. Dash into the red Dot Bot.";
  private stairCooldownMs = 0;
  private hudTimerMs = 0;

  constructor(app: Application, controls: GameControls, onHud: (hud: HudState) => void) {
    this.app = app;
    this.controls = controls;
    this.onHud = onHud;
    this.world = new this.rapier.World({ x: 0, y: 0 });

    this.root.addChild(this.mapLayer, this.objectLayer, this.dotLayer, this.botLayer, this.fxLayer, this.labels);
    this.app.stage.addChild(this.root);

    const playerDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(START_POSITION.x, START_POSITION.y)
      .setCcdEnabled(true)
      .setSoftCcdPrediction(PLAYER_RADIUS)
      .setLinearDamping(8)
      .setAngularDamping(20);
    this.playerBody = this.world.createRigidBody(playerDesc);
    const playerCollider = this.rapier.ColliderDesc.ball(PLAYER_RADIUS)
      .setRestitution(0)
      .setFriction(1.1)
      .setDensity(2);
    this.world.createCollider(playerCollider, this.playerBody);

    this.rebuildFloor("ground", START_POSITION);
    this.updateCamera();
    this.render();
    this.publishHud(true);
  }

  destroy() {
    this.app.stage.removeChild(this.root);
    this.root.destroy({ children: true });
    this.world.free();
  }

  reset() {
    this.floor = freshFloor("ground");
    this.bots = createTestBots();
    this.inventory = ["dash", "regen"];
    this.scans = 0;
    this.shields = 3;
    this.dashMs = 0;
    this.dashCooldownMs = 0;
    this.repairCooldownMs = 0;
    this.message = "Reset. Capture Dots by covering them.";
    this.rebuildFloor("ground", START_POSITION);
    this.publishHud(true);
  }

  triggerDash() {
    if (this.dashCooldownMs > 0 || this.shields <= 0) return;
    this.dashMs = 220;
    this.dashCooldownMs = 1600;
    this.message = "Dash active.";
  }

  triggerRepair() {
    if (this.shields <= 0 || this.shields >= this.maxShields || this.repairCooldownMs > 0) return;
    const spent = this.inventory.shift();
    if (!spent) {
      this.message = "Need a Dot to repair.";
      return;
    }
    this.shields += 1;
    this.repairCooldownMs = REPAIR_COOLDOWN_MS;
    this.message = `Spent ${DOT_NAMES[spent]} Dot to restore 1 Shield.`;
    this.publishHud(true);
  }

  loseShield() {
    if (this.shields <= 0) return;
    this.shields -= 1;
    this.message = this.shields === 0 ? "You are downed. Reset to keep testing." : "Lost 1 Shield.";
    this.publishHud(true);
  }

  useStairs() {
    const stair = this.activeStair();
    if (!stair || this.stairCooldownMs > 0) return;
    this.travelStair(stair);
  }

  private updateStairs() {
    if (this.stairCooldownMs > 0 || this.shields <= 0) return;
    const stair = this.activeStair();
    if (stair) this.travelStair(stair);
  }

  private activeStair() {
    const player = this.playerPosition();
    return (
      this.floor.stairs.find((stair) => {
        const halfW = stair.w / 2 + PLAYER_RADIUS * 0.25;
        const halfH = stair.h / 2 + PLAYER_RADIUS * 0.25;
        return (
          player.x >= stair.x - halfW &&
          player.x <= stair.x + halfW &&
          player.y >= stair.y - halfH &&
          player.y <= stair.y + halfH
        );
      }) ?? null
    );
  }

  private travelStair(stair: Stair) {
    this.rebuildFloor(stair.toFloor, stair.toPosition);
    this.stairCooldownMs = 760;
    this.message = `Moved to ${this.floor.label}.`;
    this.publishHud(true);
  }

  tick(ticker: Ticker) {
    const dt = Math.min(ticker.deltaMS, 50);
    this.hudTimerMs += dt;
    this.stairCooldownMs = Math.max(0, this.stairCooldownMs - dt);
    this.dashCooldownMs = Math.max(0, this.dashCooldownMs - dt);
    this.repairCooldownMs = Math.max(0, this.repairCooldownMs - dt);
    this.dashMs = Math.max(0, this.dashMs - dt);

    this.updatePlayerVelocity();
    this.updateBots(dt);
    const previousPlayerPosition = this.playerPosition();
    this.world.timestep = 1 / 60;
    this.world.step();
    this.resolvePlayerWallCollision(previousPlayerPosition);
    const playerBeforeContacts = this.playerPosition();
    this.resolveBotContacts(dt);
    this.resolvePlayerWallCollision(playerBeforeContacts);
    this.updateStairs();
    this.updateDots(dt);
    this.updateScans(dt);
    this.updateChannels(dt);
    this.updateCamera();
    this.render();

    if (this.hudTimerMs >= 120) {
      this.publishHud(false);
      this.hudTimerMs = 0;
    }
  }

  private rebuildFloor(id: FloorId, playerPosition: Vec2) {
    for (const collider of this.colliders) {
      this.world.removeCollider(collider, true);
    }
    this.colliders = [];
    this.floor = freshFloor(id);
    this.playerBody.setTranslation(playerPosition, true);
    this.playerBody.setLinvel({ x: 0, y: 0 }, true);

    for (const wall of this.floor.walls) {
      const collider = this.world.createCollider(
        this.rapier.ColliderDesc.cuboid(wall.w / 2, wall.h / 2)
          .setTranslation(wall.x + wall.w / 2, wall.y + wall.h / 2)
          .setFriction(1),
      );
      this.colliders.push(collider);
    }

    this.labels.removeChildren();
    for (const label of this.floor.labels) {
      this.addMapLabel(label.text, label.x, label.y, label.size);
    }
  }

  private updatePlayerVelocity() {
    if (this.shields <= 0) {
      this.playerBody.setLinvel({ x: 0, y: 0 }, true);
      return;
    }
    const inputStrength = clamp(len(this.controls.move), 0, 1);
    const move =
      inputStrength > 0.001
        ? { x: this.controls.move.x / inputStrength, y: this.controls.move.y / inputStrength }
        : { x: 0, y: 0 };
    const speed = this.dashMs > 0 ? DASH_SPEED : MOVE_SPEED;
    const velocity = { x: move.x * speed * inputStrength, y: move.y * speed * inputStrength };
    this.playerBody.setLinvel(velocity, true);
  }

  private updateBots(dt: number) {
    const seconds = dt / 1000;
    for (const bot of this.bots) {
      bot.hitCooldownMs = Math.max(0, bot.hitCooldownMs - dt);
      if (bot.floor !== this.floor.id || bot.state !== "alive") continue;
      const previous = { x: bot.x, y: bot.y };
      bot.x += bot.vx * seconds;
      bot.y += bot.vy * seconds;
      const wallCorrection = this.resolveBotWallCollision(bot, previous);
      if (Math.abs(wallCorrection.x) > 0.01) bot.vx *= -1;
      if (Math.abs(wallCorrection.y) > 0.01) bot.vy *= -1;
      if (bot.x < PLAYER_RADIUS + 30 || bot.x > MAP_W - PLAYER_RADIUS - 30) bot.vx *= -1;
      if (bot.y < PLAYER_RADIUS + 30 || bot.y > MAP_H - PLAYER_RADIUS - 30) bot.vy *= -1;
    }
  }

  private resolveBotWallCollision(bot: TestBot, previous?: Vec2): Vec2 {
    const start = { x: bot.x, y: bot.y };
    const planeHit = this.firstWallContactPlaneHit(previous ?? start, start, bot.radius);
    if (planeHit) {
      bot.x = planeHit.position.x;
      bot.y = planeHit.position.y;
    }

    for (let pass = 0; pass < 5; pass++) {
      let moved = false;

      for (const wall of this.floor.walls) {
        const correction = this.circleRectCorrection(bot.x, bot.y, bot.radius, wall, previous ?? start);
        if (!correction) continue;
        bot.x += correction.x;
        bot.y += correction.y;
        moved = true;
      }

      if (!moved) break;
    }

    return { x: bot.x - start.x, y: bot.y - start.y };
  }

  private circleRectCorrection(
    x: number,
    y: number,
    radius: number,
    wall: Wall,
    previous?: Vec2,
  ): Vec2 | null {
    const left = wall.x;
    const right = wall.x + wall.w;
    const top = wall.y;
    const bottom = wall.y + wall.h;
    const insideX = x >= left && x <= right;
    const insideY = y >= top && y <= bottom;

    if (insideX && insideY) {
      const previousSideCorrection = this.correctionFromPreviousSide(x, y, radius, wall, previous);
      if (previousSideCorrection) return previousSideCorrection;

      const centerX = left + wall.w / 2;
      const centerY = top + wall.h / 2;
      if (wall.w < wall.h) {
        return { x: x < centerX ? left - radius - x : right + radius - x, y: 0 };
      }
      if (wall.h < wall.w) {
        return { x: 0, y: y < centerY ? top - radius - y : bottom + radius - y };
      }

      const options: Vec2[] = [
        { x: left - radius - x, y: 0 },
        { x: right + radius - x, y: 0 },
        { x: 0, y: top - radius - y },
        { x: 0, y: bottom + radius - y },
      ];
      return options.reduce((best, option) =>
        len(option) < len(best) ? option : best,
      );
    }

    const closest = {
      x: clamp(x, left, right),
      y: clamp(y, top, bottom),
    };
    const delta = { x: x - closest.x, y: y - closest.y };
    const distance = len(delta);

    if (distance >= radius || distance <= 0.0001) return null;

    const push = radius - distance;
    return {
      x: (delta.x / distance) * push,
      y: (delta.y / distance) * push,
    };
  }

  private correctionFromPreviousSide(
    x: number,
    y: number,
    radius: number,
    wall: Wall,
    previous?: Vec2,
  ): Vec2 | null {
    if (!previous) return null;

    const left = wall.x;
    const right = wall.x + wall.w;
    const top = wall.y;
    const bottom = wall.y + wall.h;
    const horizontalEntry = Math.abs(x - previous.x) >= Math.abs(y - previous.y);

    if (previous.x < left && (horizontalEntry || previous.y >= top && previous.y <= bottom)) {
      return { x: left - radius - x, y: 0 };
    }
    if (previous.x > right && (horizontalEntry || previous.y >= top && previous.y <= bottom)) {
      return { x: right + radius - x, y: 0 };
    }
    if (previous.y < top) return { x: 0, y: top - radius - y };
    if (previous.y > bottom) return { x: 0, y: bottom + radius - y };
    if (previous.x < left) return { x: left - radius - x, y: 0 };
    if (previous.x > right) return { x: right + radius - x, y: 0 };

    return null;
  }

  private firstWallContactPlaneHit(
    from: Vec2,
    to: Vec2,
    radius: number,
  ): { t: number; normal: Vec2; position: Vec2 } | null {
    let best: { t: number; normal: Vec2; position: Vec2 } | null = null;

    for (const wall of this.floor.walls) {
      const hit = this.wallContactPlaneHit(from, to, radius, wall);
      if (!hit) continue;
      if (!best || hit.t < best.t) best = hit;
    }

    return best;
  }

  private wallContactPlaneHit(
    from: Vec2,
    to: Vec2,
    radius: number,
    wall: Wall,
  ): { t: number; normal: Vec2; position: Vec2 } | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const leftPlane = wall.x - radius;
    const rightPlane = wall.x + wall.w + radius;
    const topPlane = wall.y - radius;
    const bottomPlane = wall.y + wall.h + radius;
    const expandedTop = wall.y - radius;
    const expandedBottom = wall.y + wall.h + radius;
    const expandedLeft = wall.x - radius;
    const expandedRight = wall.x + wall.w + radius;
    const hits: { t: number; normal: Vec2; position: Vec2 }[] = [];

    if (dx > WALL_EPSILON && from.x <= leftPlane + WALL_EPSILON && to.x > leftPlane + WALL_EPSILON) {
      const t = (leftPlane - from.x) / dx;
      const y = from.y + dy * t;
      if (t >= 0 && t <= 1 && y >= expandedTop && y <= expandedBottom) {
        hits.push({ t, normal: { x: -1, y: 0 }, position: { x: leftPlane, y: to.y } });
      }
    }

    if (dx < -WALL_EPSILON && from.x >= rightPlane - WALL_EPSILON && to.x < rightPlane - WALL_EPSILON) {
      const t = (rightPlane - from.x) / dx;
      const y = from.y + dy * t;
      if (t >= 0 && t <= 1 && y >= expandedTop && y <= expandedBottom) {
        hits.push({ t, normal: { x: 1, y: 0 }, position: { x: rightPlane, y: to.y } });
      }
    }

    if (dy > WALL_EPSILON && from.y <= topPlane + WALL_EPSILON && to.y > topPlane + WALL_EPSILON) {
      const t = (topPlane - from.y) / dy;
      const x = from.x + dx * t;
      if (t >= 0 && t <= 1 && x >= expandedLeft && x <= expandedRight) {
        hits.push({ t, normal: { x: 0, y: -1 }, position: { x: to.x, y: topPlane } });
      }
    }

    if (dy < -WALL_EPSILON && from.y >= bottomPlane - WALL_EPSILON && to.y < bottomPlane - WALL_EPSILON) {
      const t = (bottomPlane - from.y) / dy;
      const x = from.x + dx * t;
      if (t >= 0 && t <= 1 && x >= expandedLeft && x <= expandedRight) {
        hits.push({ t, normal: { x: 0, y: 1 }, position: { x: to.x, y: bottomPlane } });
      }
    }

    return hits.reduce<{ t: number; normal: Vec2; position: Vec2 } | null>(
      (best, hit) => (!best || hit.t < best.t ? hit : best),
      null,
    );
  }

  private resolvePlayerWallCollision(previous?: Vec2) {
    if (previous) {
      const current = this.playerPosition();
      const hit = this.firstWallContactPlaneHit(previous, current, PLAYER_RADIUS);
      if (hit) {
        this.playerBody.setTranslation(hit.position, true);

        const velocity = this.playerBody.linvel();
        this.playerBody.setLinvel(
          {
            x: Math.abs(hit.normal.x) > 0 ? 0 : velocity.x,
            y: Math.abs(hit.normal.y) > 0 ? 0 : velocity.y,
          },
          true,
        );
      }
    }

    for (let pass = 0; pass < 5; pass++) {
      let moved = false;
      const player = this.playerPosition();

      for (const wall of this.floor.walls) {
        const correction = this.circleRectCorrection(player.x, player.y, PLAYER_RADIUS, wall, previous);
        if (!correction) continue;

        this.playerBody.setTranslation(
          { x: player.x + correction.x, y: player.y + correction.y },
          true,
        );
        const velocity = this.playerBody.linvel();
        this.playerBody.setLinvel(
          {
            x: Math.abs(correction.x) > 0.001 ? 0 : velocity.x,
            y: Math.abs(correction.y) > 0.001 ? 0 : velocity.y,
          },
          true,
        );
        moved = true;
        break;
      }

      if (!moved) break;
    }
  }

  private segmentExpandedRectHit(from: Vec2, to: Vec2, radius: number, wall: Wall): { t: number; normal: Vec2 } | null {
    const expanded = {
      left: wall.x - radius,
      right: wall.x + wall.w + radius,
      top: wall.y - radius,
      bottom: wall.y + wall.h + radius,
    };
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return null;

    let tMin = 0;
    let tMax = 1;
    let normal: Vec2 = { x: 0, y: 0 };

    if (Math.abs(dx) < 0.0001) {
      if (from.x < expanded.left || from.x > expanded.right) return null;
    } else {
      const inv = 1 / dx;
      let t1 = (expanded.left - from.x) * inv;
      let t2 = (expanded.right - from.x) * inv;
      let axisNormal: Vec2 = dx > 0 ? { x: -1, y: 0 } : { x: 1, y: 0 };
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
      }
      if (t1 > tMin) {
        tMin = t1;
        normal = axisNormal;
      }
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }

    if (Math.abs(dy) < 0.0001) {
      if (from.y < expanded.top || from.y > expanded.bottom) return null;
    } else {
      const inv = 1 / dy;
      let t1 = (expanded.top - from.y) * inv;
      let t2 = (expanded.bottom - from.y) * inv;
      let axisNormal: Vec2 = dy > 0 ? { x: 0, y: -1 } : { x: 0, y: 1 };
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
      }
      if (t1 > tMin) {
        tMin = t1;
        normal = axisNormal;
      }
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }

    const startedInside =
      from.x >= expanded.left &&
      from.x <= expanded.right &&
      from.y >= expanded.top &&
      from.y <= expanded.bottom;
    if (startedInside || tMin < 0 || tMin > 1) return null;

    return { t: tMin, normal };
  }

  private resolveBotContacts(dt: number) {
    if (this.shields <= 0) return;
    const player = this.playerPosition();
    const velocity = this.playerBody.linvel();
    const playerSpeed = Math.hypot(velocity.x, velocity.y);

    for (const bot of this.bots) {
      if (bot.floor !== this.floor.id || bot.state !== "alive") continue;
      const separation = { x: player.x - bot.x, y: player.y - bot.y };
      const distance = Math.max(1, len(separation));
      const minDistance = PLAYER_RADIUS + bot.radius;
      if (distance >= minDistance) continue;

      const normal = { x: separation.x / distance, y: separation.y / distance };
      const overlap = minDistance - distance;
      bot.x -= normal.x * overlap;
      bot.y -= normal.y * overlap;
      this.resolveBotWallCollision(bot);

      const botSpeed = Math.hypot(bot.vx, bot.vy);
      const damagingPlayerHit = playerSpeed > HIT_SPEED || this.dashMs > 0;
      const damagingEnemyHit = botSpeed > HIT_SPEED + 120;

      if (damagingPlayerHit && bot.hitCooldownMs <= 0) {
        bot.shields = Math.max(0, bot.shields - 1);
        bot.hitCooldownMs = 650;
        this.message = `${bot.label} lost 1 Shield.`;
        if (bot.shields === 0) {
          bot.state = "downed";
          bot.vx = 0;
          bot.vy = 0;
          this.message = `${bot.label} is downed. Cover it to consume.`;
        }
      } else if (damagingEnemyHit && bot.hitCooldownMs <= 0 && this.shields > 0) {
        this.shields = Math.max(0, this.shields - 1);
        bot.hitCooldownMs = 650;
        this.message = this.shields === 0 ? "You are downed." : "You lost 1 Shield.";
      }
      void dt;
    }
  }

  private updateDots(dt: number) {
    const player = this.playerPosition();
    for (const dot of this.floor.dots) {
      const covered = dist(player, dot) + dot.radius <= PLAYER_RADIUS - 2;
      if (covered && this.shields > 0) {
        dot.capturedMs += dt;
        if (dot.capturedMs >= dot.captureMs) {
          this.inventory.push(dot.type);
          this.floor.dots = this.floor.dots.filter((candidate) => candidate.id !== dot.id);
          this.message = `Captured ${DOT_NAMES[dot.type]} Dot.`;
          this.publishHud(true);
          break;
        }
      } else {
        dot.capturedMs = Math.max(0, dot.capturedMs - dt * 0.8);
      }
    }
  }

  private updateScans(dt: number) {
    const target = this.nearestScanObject();
    if (!target) return;
    if (this.controls.scanHeld && this.shields > 0) {
      target.scannedMs += dt;
      if (target.scannedMs >= target.scanMs && !target.completed) {
        target.completed = true;
        this.scans += 1;
        this.message = `Scan extracted later: ${OBJECT_DEFINITIONS[target.kind].label}.`;
        this.publishHud(true);
      }
    } else if (!target.completed) {
      target.scannedMs = Math.max(0, target.scannedMs - dt * 0.4);
    }
  }

  private updateChannels(dt: number) {
    const player = this.playerPosition();
    let consumeActive = false;
    let reviveActive = false;

    for (const bot of this.bots) {
      if (bot.floor !== this.floor.id) {
        bot.channelMs = 0;
        continue;
      }
      if (bot.state !== "downed") {
        bot.channelMs = 0;
        continue;
      }
      const covered = dist(player, bot) + 8 <= PLAYER_RADIUS;
      if (!covered || this.shields <= 0) {
        bot.channelMs = Math.max(0, bot.channelMs - dt * 0.8);
        continue;
      }

      bot.channelMs += dt;
      if (bot.id.includes("teammate")) {
        reviveActive = true;
        if (bot.channelMs >= REVIVE_MS) {
          const spent = this.inventory.shift();
          if (!spent) {
            this.message = "Need a Dot in Inventory to revive.";
            bot.channelMs = 0;
          } else {
            bot.state = "alive";
            bot.shields = 1;
            bot.x += 58;
            bot.vx = -55;
            this.message = `Spent ${DOT_NAMES[spent]} Dot. Teammate revived.`;
          }
          this.publishHud(true);
        }
      } else {
        consumeActive = true;
        if (bot.channelMs >= CONSUME_MS) {
          bot.state = "consumed";
          this.inventory.push(...bot.inventory);
          this.message = `Consumed ${bot.label}. Took ${bot.inventory.length} Dots.`;
          this.publishHud(true);
        }
      }
    }

    if (consumeActive || reviveActive) this.publishHud(false);
  }

  private nearestScanObject() {
    const player = this.playerPosition();
    return (
      this.floor.objects.find(
        (object) =>
          object.scannable &&
          !object.completed &&
          dist(player, object) <= PLAYER_RADIUS + this.objectScanRadius(object),
      ) ?? null
    );
  }

  private playerPosition(): Vec2 {
    const pos = this.playerBody.translation();
    return { x: pos.x, y: pos.y };
  }

  private updateCamera() {
    const player = this.playerPosition();
    const width = this.app.canvas.clientWidth || this.app.renderer.width;
    const height = this.app.canvas.clientHeight || this.app.renderer.height;
    const zoom = width < 720 ? 0.62 : 0.82;
    const bounds = this.floor.camera;
    const viewportWorldW = width / zoom;
    const viewportWorldH = height / zoom;
    const edgeGutter = width < 720 ? 140 : 220;
    const cameraX = this.cameraAxis(player.x, viewportWorldW, bounds.x, bounds.w, edgeGutter);
    const cameraY = this.cameraAxis(player.y, viewportWorldH, bounds.y, bounds.h, edgeGutter);
    this.root.scale.set(zoom);
    this.root.position.set(-cameraX * zoom, -cameraY * zoom);
  }

  private cameraAxis(playerPosition: number, viewportSize: number, boundsStart: number, boundsSize: number, gutter: number) {
    const preferred = playerPosition - viewportSize / 2;
    if (boundsSize + gutter * 2 <= viewportSize) return preferred;

    const min = boundsStart - gutter;
    const max = boundsStart + boundsSize - viewportSize + gutter;
    if (min > max) return preferred;
    return clamp(preferred, min, max);
  }

  private render() {
    const time = performance.now();
    this.drawMap();
    this.drawObjects(time);
    this.drawDots();
    this.drawBots(time);
    this.drawFx(time);
  }

  private drawMap() {
    const g = this.mapLayer;
    g.clear();
    g.rect(0, 0, MAP_W, MAP_H).fill({ color: 0xffffff });
    if (this.floor.id === "ground") {
      this.drawCityGround(g);
    } else {
      this.drawInteriorBackdrop(g);
    }

    for (const wall of this.floor.walls) {
      this.drawWallRect(g, wall);
    }

    for (const stair of this.floor.stairs) {
      this.drawStairPort(g, stair);
    }
  }

  private drawCityGround(g: Graphics) {
    g.rect(24, 24, MAP_W - 48, MAP_H - 48).stroke({ color: 0xd6d8dc, width: 1 });
    for (const road of this.floor.roads ?? []) {
      g.rect(road.x, road.y, road.w, road.h).fill({ color: 0xf0f1f3 });
      this.drawLaneLines(g, road);
    }
    for (const sidewalk of this.floor.sidewalks ?? []) {
      g.rect(sidewalk.x, sidewalk.y, sidewalk.w, sidewalk.h).fill({ color: 0xf8f8f8 });
      g.rect(sidewalk.x, sidewalk.y, sidewalk.w, sidewalk.h).stroke({ color: 0xd7d9dd, width: 1 });
    }
  }

  private drawWallRect(g: Graphics, wall: Wall) {
    g.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: 0x111111 });
  }

  private drawWindowSlots(g: Graphics, windows: WindowSlot[]) {
    for (const window of windows) {
      g.rect(window.x, window.y, window.w, window.h).fill({ color: 0xffffff });
      g.rect(window.x, window.y, window.w, window.h).stroke({ color: 0x8f959d, width: 0.8, alpha: 0.9 });
      if (window.w > window.h) {
        g.beginPath();
        g.moveTo(window.x, window.y + window.h / 2);
        g.lineTo(window.x + window.w, window.y + window.h / 2);
        g.stroke({ color: 0xc8ccd1, width: 0.7 });
      } else {
        g.beginPath();
        g.moveTo(window.x + window.w / 2, window.y);
        g.lineTo(window.x + window.w / 2, window.y + window.h);
        g.stroke({ color: 0xc8ccd1, width: 0.7 });
      }
    }
  }

  private drawRoundedZone(g: Graphics, zone: RoundedZone, color: number, width: number, alpha: number) {
    g.roundRect(zone.x, zone.y, zone.w, zone.h, zone.radius).stroke({ color, width, alpha });
  }

  private drawCrosswalk(g: Graphics, crosswalk: Crosswalk) {
    const stripes = crosswalk.orientation === "horizontal" ? 7 : 6;
    for (let i = 0; i < stripes; i++) {
      if (crosswalk.orientation === "horizontal") {
        const stripeW = crosswalk.w / (stripes * 1.6);
        const gap = (crosswalk.w - stripeW * stripes) / Math.max(1, stripes - 1);
        const x = crosswalk.x + i * (stripeW + gap);
        g.rect(x, crosswalk.y, stripeW, crosswalk.h).stroke({ color: 0xc3c7ce, width: 1.2, alpha: 0.9 });
      } else {
        const stripeH = crosswalk.h / (stripes * 1.6);
        const gap = (crosswalk.h - stripeH * stripes) / Math.max(1, stripes - 1);
        const y = crosswalk.y + i * (stripeH + gap);
        g.rect(crosswalk.x, y, crosswalk.w, stripeH).stroke({ color: 0xc3c7ce, width: 1.2, alpha: 0.9 });
      }
    }
  }

  private drawDetailLinework(g: Graphics, lines: DetailLine[]) {
    for (const line of lines) {
      g.beginPath();
      g.moveTo(line.x1, line.y1);
      g.lineTo(line.x2, line.y2);
      g.stroke({ color: 0x8f969f, width: line.width ?? 1, alpha: line.alpha ?? 0.34 });
    }
  }

  private drawRoomOutlines(g: Graphics, rooms: RoomOutline[]) {
    for (const room of rooms) {
      this.drawRoomEdge(g, room, "top", room.x, room.y, room.x + room.w, room.y);
      this.drawRoomEdge(g, room, "right", room.x + room.w, room.y, room.x + room.w, room.y + room.h);
      this.drawRoomEdge(g, room, "bottom", room.x, room.y + room.h, room.x + room.w, room.y + room.h);
      this.drawRoomEdge(g, room, "left", room.x, room.y, room.x, room.y + room.h);
    }
  }

  private drawRoomEdge(
    g: Graphics,
    room: RoomOutline,
    side: Gap["side"],
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) {
    const horizontal = y1 === y2;
    const length = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
    const gaps = (room.gaps ?? [])
      .filter((gap) => gap.side === side)
      .map((gap) => ({ start: gap.start, end: gap.start + gap.size }));
    const alpha = room.alpha ?? 0.42;

    for (const segment of wallSegments(0, length, gaps)) {
      g.beginPath();
      if (horizontal) {
        const startX = x1 + segment.start;
        const endX = x1 + segment.end;
        g.moveTo(startX, y1);
        g.lineTo(endX, y2);
      } else {
        const startY = y1 + segment.start;
        const endY = y1 + segment.end;
        g.moveTo(x1, startY);
        g.lineTo(x2, endY);
      }
      g.stroke({ color: 0x6f7680, width: 0.9, alpha });
    }
  }

  private drawFloorDecals(g: Graphics, decals: FloorDecal[]) {
    for (const decal of decals) {
      const definition = FLOOR_DECAL_DEFINITIONS[decal.kind];
      const color = definition.color;
      const rect = this.objectRect(decal.rotation, decal.w, decal.h);
      const x = decal.x - rect.w / 2;
      const y = decal.y - rect.h / 2;
      const alpha = decal.alpha ?? definition.defaultAlpha;

      if (decal.kind === "thin-rect") {
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 0.9, alpha });
        this.drawRectDivisions(g, x, y, rect.w, rect.h, decal.cells ?? 0, alpha * 0.62);
      }

      if (decal.kind === "hatch-box") {
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 1.2, alpha });
        g.beginPath();
        g.moveTo(x + 6, y + 6);
        g.lineTo(x + rect.w - 6, y + rect.h - 6);
        g.moveTo(x + rect.w - 6, y + 6);
        g.lineTo(x + 6, y + rect.h - 6);
        g.stroke({ color, width: 0.8, alpha: alpha * 0.62 });
      }

      if (decal.kind === "panel-grid") {
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 1.1, alpha });
        this.drawRectDivisions(g, x, y, rect.w, rect.h, decal.cells ?? 3, alpha * 0.72);
      }

      if (decal.kind === "counter-run") {
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 1.2, alpha });
        g.rect(x + 5, y + 5, rect.w - 10, rect.h - 10).stroke({ color, width: 0.7, alpha: alpha * 0.46 });
        this.drawRectDivisions(g, x, y, rect.w, rect.h, decal.cells ?? 3, alpha * 0.62);
      }

      if (decal.kind === "chair-row") {
        const count = Math.max(1, decal.cells ?? 4);
        const horizontal = rect.w >= rect.h;
        const chairW = horizontal ? rect.w / count - 6 : rect.w - 8;
        const chairH = horizontal ? rect.h - 8 : rect.h / count - 6;
        for (let i = 0; i < count; i++) {
          const chairX = horizontal ? x + 4 + i * (rect.w / count) : x + 4;
          const chairY = horizontal ? y + 4 : y + 4 + i * (rect.h / count);
          g.rect(chairX, chairY, chairW, chairH).stroke({ color, width: 1, alpha });
          if (horizontal) {
            g.beginPath();
            g.moveTo(chairX + 3, chairY + chairH - 4);
            g.lineTo(chairX + chairW - 3, chairY + chairH - 4);
          } else {
            g.beginPath();
            g.moveTo(chairX + chairW - 4, chairY + 3);
            g.lineTo(chairX + chairW - 4, chairY + chairH - 3);
          }
          g.stroke({ color, width: 0.7, alpha: alpha * 0.58 });
        }
      }

      if (decal.kind === "fixture-row") {
        const count = Math.max(1, decal.cells ?? 4);
        const horizontal = rect.w >= rect.h;
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 0.9, alpha: alpha * 0.58 });
        for (let i = 0; i < count; i++) {
          const cx = horizontal ? x + (rect.w / count) * (i + 0.5) : x + rect.w / 2;
          const cy = horizontal ? y + rect.h / 2 : y + (rect.h / count) * (i + 0.5);
          const radius = Math.min(rect.w / (horizontal ? count * 3.2 : 3.4), rect.h / (horizontal ? 3.4 : count * 3.2), 7);
          g.circle(cx, cy, radius).stroke({ color, width: 0.8, alpha });
          g.circle(cx, cy, radius * 0.36).fill({ color, alpha: alpha * 0.34 });
        }
      }

      if (decal.kind === "parking-row") {
        const count = Math.max(1, decal.cells ?? 4);
        const horizontal = rect.w >= rect.h;
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 0.9, alpha });
        g.beginPath();
        for (let i = 1; i < count; i++) {
          if (horizontal) {
            const sx = x + (rect.w / count) * i;
            g.moveTo(sx, y + 6);
            g.lineTo(sx, y + rect.h - 6);
          } else {
            const sy = y + (rect.h / count) * i;
            g.moveTo(x + 6, sy);
            g.lineTo(x + rect.w - 6, sy);
          }
        }
        if (horizontal) {
          g.moveTo(x + 8, y + rect.h * 0.72);
          g.lineTo(x + rect.w - 8, y + rect.h * 0.72);
        } else {
          g.moveTo(x + rect.w * 0.72, y + 8);
          g.lineTo(x + rect.w * 0.72, y + rect.h - 8);
        }
        g.stroke({ color, width: 0.85, alpha });
      }

      if (decal.kind === "paver-row") {
        const count = Math.max(1, decal.cells ?? 6);
        const horizontal = rect.w >= rect.h;
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 0.8, alpha: alpha * 0.8 });
        g.beginPath();
        for (let i = 1; i < count; i++) {
          if (horizontal) {
            const sx = x + (rect.w / count) * i;
            g.moveTo(sx, y + 5);
            g.lineTo(sx, y + rect.h - 5);
          } else {
            const sy = y + (rect.h / count) * i;
            g.moveTo(x + 5, sy);
            g.lineTo(x + rect.w - 5, sy);
          }
        }
        const lanes = horizontal ? 2 : 3;
        for (let i = 1; i < lanes; i++) {
          if (horizontal) {
            const sy = y + (rect.h / lanes) * i;
            g.moveTo(x + 6, sy);
            g.lineTo(x + rect.w - 6, sy);
          } else {
            const sx = x + (rect.w / lanes) * i;
            g.moveTo(sx, y + 6);
            g.lineTo(sx, y + rect.h - 6);
          }
        }
        g.stroke({ color, width: 0.75, alpha });
      }

      if (decal.kind === "entry-stairs") {
        const horizontal = rect.w >= rect.h;
        g.rect(x, y, rect.w, rect.h).fill({ color: 0xffffff, alpha: 0.68 });
        g.rect(x, y, rect.w, rect.h).stroke({ color, width: 1.2, alpha });
        g.beginPath();
        const steps = Math.max(4, decal.cells ?? 6);
        for (let i = 1; i < steps; i++) {
          if (horizontal) {
            const sx = x + (rect.w / steps) * i;
            g.moveTo(sx, y + 8);
            g.lineTo(sx, y + rect.h - 8);
          } else {
            const sy = y + (rect.h / steps) * i;
            g.moveTo(x + 8, sy);
            g.lineTo(x + rect.w - 8, sy);
          }
        }
        g.stroke({ color, width: 0.85, alpha: alpha * 0.58 });

        const bracket = 9;
        const inset = 5;
        g.beginPath();
        g.moveTo(x + inset, y + inset + bracket);
        g.lineTo(x + inset, y + inset);
        g.lineTo(x + inset + bracket, y + inset);
        g.moveTo(x + rect.w - inset - bracket, y + inset);
        g.lineTo(x + rect.w - inset, y + inset);
        g.lineTo(x + rect.w - inset, y + inset + bracket);
        g.moveTo(x + inset, y + rect.h - inset - bracket);
        g.lineTo(x + inset, y + rect.h - inset);
        g.lineTo(x + inset + bracket, y + rect.h - inset);
        g.moveTo(x + rect.w - inset - bracket, y + rect.h - inset);
        g.lineTo(x + rect.w - inset, y + rect.h - inset);
        g.lineTo(x + rect.w - inset, y + rect.h - inset - bracket);
        g.stroke({ color, width: 0.9, alpha: alpha * 0.6 });

        this.drawArrow(g, decal.x, decal.y, decal.arrow ?? "up", Math.min(rect.w, rect.h) * 0.2, color, 1.5, alpha);
      }
    }
  }

  private drawRectDivisions(g: Graphics, x: number, y: number, w: number, h: number, cells: number, alpha: number) {
    if (cells <= 1) return;
    g.beginPath();
    for (let i = 1; i < cells; i++) {
      if (w >= h) {
        const sx = x + (w / cells) * i;
        g.moveTo(sx, y + 3);
        g.lineTo(sx, y + h - 3);
      } else {
        const sy = y + (h / cells) * i;
        g.moveTo(x + 3, sy);
        g.lineTo(x + w - 3, sy);
      }
    }
    g.stroke({ color: 0x111111, width: 0.7, alpha });
  }

  private drawDoorSwings(g: Graphics, doors: DoorSwing[]) {
    for (const door of doors) {
      const leafX = door.x + Math.cos(door.end) * door.radius;
      const leafY = door.y + Math.sin(door.end) * door.radius;
      g.beginPath();
      g.moveTo(door.x, door.y);
      g.lineTo(leafX, leafY);
      g.stroke({ color: 0x111111, width: 1.2, alpha: 0.72 });
      g.beginPath();
      g.arc(door.x, door.y, door.radius, door.start, door.end);
      g.stroke({ color: 0x8f969f, width: 0.9, alpha: 0.48 });
    }
  }

  private drawInteriorBackdrop(g: Graphics) {
    g.rect(0, 0, MAP_W, MAP_H).fill({ color: 0xf9f9fa });
    if (!this.floor.area) return;
    const area = this.floor.area;
    g.rect(area.x - 42, area.y - 42, area.w + 84, area.h + 84).fill({ color: 0xffffff });
    g.rect(area.x - 42, area.y - 42, area.w + 84, area.h + 84).stroke({
      color: 0xe3e5e8,
      width: 1,
    });
    g.rect(area.x, area.y, area.w, area.h).fill({ color: 0xffffff });
    this.drawFloorGrid(g, area);
  }

  private drawLaneLines(g: Graphics, road: Wall) {
    g.beginPath();
    if (road.w >= road.h) {
      const y = road.y + road.h / 2;
      for (let x = road.x + 46; x < road.x + road.w - 20; x += 84) {
        g.moveTo(x, y);
        g.lineTo(x + 34, y);
      }
    } else {
      const x = road.x + road.w / 2;
      for (let y = road.y + 46; y < road.y + road.h - 20; y += 84) {
        g.moveTo(x, y);
        g.lineTo(x, y + 34);
      }
    }
    g.stroke({ color: 0xc9ccd1, width: 2, alpha: 0.78 });
  }

  private drawFloorGrid(g: Graphics, area: Wall) {
    g.beginPath();
    for (let x = area.x + 64; x < area.x + area.w; x += 64) {
      g.moveTo(x, area.y + 12);
      g.lineTo(x, area.y + area.h - 12);
    }
    for (let y = area.y + 64; y < area.y + area.h; y += 64) {
      g.moveTo(area.x + 12, y);
      g.lineTo(area.x + area.w - 12, y);
    }
    g.stroke({ color: 0xeff0f2, width: 1 });
  }

  private drawBuildingFootprint(g: Graphics, building: BuildingFootprint) {
    const outline = building.outline ?? [
      { x: building.x, y: building.y },
      { x: building.x + building.w, y: building.y },
      { x: building.x + building.w, y: building.y + building.h },
      { x: building.x, y: building.y + building.h },
    ];
    this.drawPolygon(g, outline, 0xfbfbfb, 0x111111, 1.7, 0.72);
    this.drawPolygonInsetLines(g, outline, 10);
    if (building.entry) {
      g.circle(building.entry.x, building.entry.y, 9).fill({ color: 0xffffff });
      g.circle(building.entry.x, building.entry.y, 9).stroke({ color: 0x111111, width: 1.5 });
    }
  }

  private drawPolygon(g: Graphics, points: Vec2[], fill: number, stroke: number, width: number, alpha: number) {
    if (!points.length) return;
    g.beginPath();
    g.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) {
      g.lineTo(point.x, point.y);
    }
    g.closePath();
    g.fill({ color: fill });
    g.stroke({ color: stroke, width, alpha });
  }

  private drawPolygonInsetLines(g: Graphics, points: Vec2[], inset: number) {
    g.beginPath();
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 70) continue;
      const nx = -dy / length;
      const ny = dx / length;
      const start = { x: a.x + dx * 0.18 + nx * inset, y: a.y + dy * 0.18 + ny * inset };
      const end = { x: a.x + dx * 0.82 + nx * inset, y: a.y + dy * 0.82 + ny * inset };
      g.moveTo(start.x, start.y);
      g.lineTo(end.x, end.y);
    }
    g.stroke({ color: 0xc6cbd1, width: 0.8, alpha: 0.56 });
  }

  private drawGroundPatch(g: Graphics, patch: GroundPatch) {
    const definition = GROUND_PATCH_DEFINITIONS[patch.kind];
    const radius = patch.radius ?? 0;
    const drawShape = () => {
      if (radius > 0) {
        g.roundRect(patch.x, patch.y, patch.w, patch.h, radius);
      } else {
        g.rect(patch.x, patch.y, patch.w, patch.h);
      }
    };

    drawShape();
    g.fill({ color: definition.fill, alpha: definition.defaultAlpha });
    drawShape();
    g.stroke({ color: definition.stroke, width: 1, alpha: 1 });

    g.beginPath();
    if (patch.dividers?.includes("horizontal")) {
      const y = patch.y + patch.h / 2;
      g.moveTo(patch.x, y);
      g.lineTo(patch.x + patch.w, y);
    }
    if (patch.dividers?.includes("vertical")) {
      const x = patch.x + patch.w / 2;
      g.moveTo(x, patch.y);
      g.lineTo(x, patch.y + patch.h);
    }
    g.stroke({ color: 0xd2d5d9, width: 1.5 });
  }

  private drawPlant(g: Graphics, x: number, y: number, radius: number, kind: Plant["kind"], alpha: number) {
    if (kind === "lamp") {
      g.circle(x, y, radius).stroke({ color: 0x111111, width: 1.2, alpha: alpha * 0.72 });
      g.circle(x, y, radius * 0.46).fill({ color: 0xffffff });
      g.circle(x, y, radius * 0.46).stroke({ color: 0x111111, width: 1.1, alpha });
      g.circle(x, y, radius * 0.18).fill({ color: 0x111111, alpha: alpha * 0.72 });
      return;
    }
    if (kind === "planter") {
      const left = x - radius - 12;
      const top = y - radius / 1.45;
      const width = radius * 2 + 24;
      const height = radius * 1.38;
      g.rect(left, top, width, height).stroke({
        color: 0x111111,
        width: 1.5,
        alpha,
      });
      for (let i = 0; i < 3; i++) {
        const cx = left + width * (0.25 + i * 0.25);
        this.drawLeafGlyph(g, cx, y, radius * 0.34, alpha * 0.75);
      }
      return;
    }
    g.circle(x, y, radius).stroke({ color: 0x111111, width: kind === "tree" ? 1.5 : 1.1, alpha });
    this.drawLeafGlyph(g, x, y, radius * (kind === "tree" ? 0.72 : 0.56), alpha * 0.75);
  }

  private drawStreetFixture(g: Graphics, fixture: StreetFixture) {
    const { x, y, radius } = fixture;
    const definition = STREET_FIXTURE_DEFINITIONS[fixture.kind];
    const color = definition.color;
    const alpha = definition.defaultAlpha;
    if (fixture.kind === "utility-cover") {
      g.circle(x, y, radius).stroke({ color, width: 1, alpha });
      g.circle(x, y, radius * 0.45).stroke({ color, width: 0.8, alpha: alpha * 0.8 });
      g.beginPath();
      g.moveTo(x - radius * 0.55, y);
      g.lineTo(x + radius * 0.55, y);
      g.moveTo(x, y - radius * 0.55);
      g.lineTo(x, y + radius * 0.55);
      g.stroke({ color, width: 0.7, alpha: alpha * 0.72 });
      return;
    }

    if (fixture.kind === "sign") {
      g.circle(x, y, radius * 0.7).fill({ color: 0xffffff, alpha: 0.92 });
      g.circle(x, y, radius * 0.7).stroke({ color, width: 1, alpha });
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const angle = Math.PI / 4 + (Math.PI * 2 * i) / 4;
        g.moveTo(x + Math.cos(angle) * radius * 1.1, y + Math.sin(angle) * radius * 1.1);
        g.lineTo(x + Math.cos(angle) * radius * 1.65, y + Math.sin(angle) * radius * 1.65);
      }
      g.stroke({ color, width: 0.8, alpha: alpha * 0.7 });
      return;
    }

    g.circle(x, y, radius).fill({ color: 0xffffff, alpha: 0.9 });
    g.circle(x, y, radius).stroke({ color, width: 1, alpha });
    g.circle(x, y, Math.max(2, radius * 0.34)).fill({ color, alpha: alpha * 0.88 });
  }

  private drawLeafGlyph(g: Graphics, x: number, y: number, radius: number, alpha: number) {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      const inner = radius * 0.2;
      const outer = radius;
      g.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
      g.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    }
    g.stroke({ color: 0x111111, width: 0.9, alpha });
  }

  private drawExtractionZone(g: Graphics, zone: ExtractionZone) {
    const accent = zone.accent ?? 0x36d65c;
    g.roundRect(zone.x, zone.y, zone.w, zone.h, zone.radius).fill({ color: accent, alpha: 0.015 });
    g.roundRect(zone.x, zone.y, zone.w, zone.h, zone.radius).stroke({ color: accent, width: 0.9, alpha: 0.22 });
    this.drawDashedRect(g, zone.x, zone.y, zone.w, zone.h, 16, 10, accent, 1.6, 0.82);
    const centerX = zone.x + zone.w / 2;
    const centerY = zone.y + zone.h / 2;
    const bracket = Math.min(zone.w, zone.h) * 0.13;
    const bracketInset = Math.min(zone.w, zone.h) * 0.26;

    g.beginPath();
    g.moveTo(centerX - bracketInset, centerY - bracketInset + bracket);
    g.lineTo(centerX - bracketInset, centerY - bracketInset);
    g.lineTo(centerX - bracketInset + bracket, centerY - bracketInset);
    g.moveTo(centerX + bracketInset - bracket, centerY - bracketInset);
    g.lineTo(centerX + bracketInset, centerY - bracketInset);
    g.lineTo(centerX + bracketInset, centerY - bracketInset + bracket);
    g.moveTo(centerX - bracketInset, centerY + bracketInset - bracket);
    g.lineTo(centerX - bracketInset, centerY + bracketInset);
    g.lineTo(centerX - bracketInset + bracket, centerY + bracketInset);
    g.moveTo(centerX + bracketInset - bracket, centerY + bracketInset);
    g.lineTo(centerX + bracketInset, centerY + bracketInset);
    g.lineTo(centerX + bracketInset, centerY + bracketInset - bracket);
    g.stroke({ color: 0x111111, width: 1.1, alpha: 0.68 });

    this.drawArrow(g, centerX, centerY, zone.arrow, Math.min(zone.w, zone.h) * 0.18, accent, 2.2, 0.95);
    this.drawSignalBulb(g, zone.x + zone.w - 18, zone.y + 18, accent);
  }

  private drawSignalBulb(g: Graphics, x: number, y: number, color: number) {
    g.circle(x, y, 8).fill({ color, alpha: 0.18 });
    g.circle(x, y, 5).fill({ color, alpha: 0.92 });
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      g.moveTo(x + Math.cos(angle) * 12, y + Math.sin(angle) * 12);
      g.lineTo(x + Math.cos(angle) * 18, y + Math.sin(angle) * 18);
    }
    g.stroke({ color, width: 1.4, alpha: 0.72 });
  }

  private drawDashedRect(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    dash: number,
    gap: number,
    color: number,
    width: number,
    alpha: number,
  ) {
    this.drawDashedLine(g, x, y, x + w, y, dash, gap, color, width, alpha);
    this.drawDashedLine(g, x + w, y, x + w, y + h, dash, gap, color, width, alpha);
    this.drawDashedLine(g, x + w, y + h, x, y + h, dash, gap, color, width, alpha);
    this.drawDashedLine(g, x, y + h, x, y, dash, gap, color, width, alpha);
  }

  private drawDashedLine(
    g: Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    dash: number,
    gap: number,
    color: number,
    width: number,
    alpha: number,
  ) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length <= 0.001) return;
    const ux = dx / length;
    const uy = dy / length;
    for (let cursor = 0; cursor < length; cursor += dash + gap) {
      const end = Math.min(cursor + dash, length);
      g.beginPath();
      g.moveTo(x1 + ux * cursor, y1 + uy * cursor);
      g.lineTo(x1 + ux * end, y1 + uy * end);
      g.stroke({ color, width, alpha });
    }
  }

  private drawArrow(
    g: Graphics,
    x: number,
    y: number,
    direction: Direction,
    size: number,
    color: number,
    width: number,
    alpha: number,
  ) {
    const vector =
      direction === "up"
        ? { x: 0, y: -1 }
        : direction === "down"
          ? { x: 0, y: 1 }
          : direction === "left"
            ? { x: -1, y: 0 }
            : { x: 1, y: 0 };
    const perpendicular = { x: -vector.y, y: vector.x };
    const tail = { x: x - vector.x * size * 0.62, y: y - vector.y * size * 0.62 };
    const tip = { x: x + vector.x * size * 0.62, y: y + vector.y * size * 0.62 };
    const wingBase = { x: tip.x - vector.x * size * 0.38, y: tip.y - vector.y * size * 0.38 };
    g.beginPath();
    g.moveTo(tail.x, tail.y);
    g.lineTo(tip.x, tip.y);
    g.moveTo(tip.x, tip.y);
    g.lineTo(wingBase.x + perpendicular.x * size * 0.35, wingBase.y + perpendicular.y * size * 0.35);
    g.moveTo(tip.x, tip.y);
    g.lineTo(wingBase.x - perpendicular.x * size * 0.35, wingBase.y - perpendicular.y * size * 0.35);
    g.stroke({ color, width, alpha });
  }

  private drawStairPort(g: Graphics, stair: Stair) {
    const x = stair.x - stair.w / 2;
    const y = stair.y - stair.h / 2;
    if (stair.visual === "entry") {
      this.drawEntryPort(g, stair, x, y);
      return;
    }

    g.rect(x, y, stair.w, stair.h).fill({ color: 0xffffff, alpha: 0.92 });
    g.rect(x, y, stair.w, stair.h).stroke({ color: 0x111111, width: 1.5, alpha: 0.82 });
    g.rect(x + 5, y + 5, stair.w - 10, stair.h - 10).stroke({
      color: 0x111111,
      width: 0.8,
      alpha: 0.32,
    });

    g.beginPath();
    if (stair.w >= stair.h) {
      const steps = 6;
      for (let i = 0; i <= steps; i++) {
        const sx = x + 12 + i * ((stair.w - 24) / steps);
        g.moveTo(sx, y + 8);
        g.lineTo(sx, y + stair.h - 8);
      }
    } else {
      const steps = 6;
      for (let i = 0; i <= steps; i++) {
        const sy = y + 12 + i * ((stair.h - 24) / steps);
        g.moveTo(x + 8, sy);
        g.lineTo(x + stair.w - 8, sy);
      }
    }
    g.stroke({ color: 0x111111, width: 1, alpha: 0.7 });

    const up = stair.toFloor.includes("f2");
    const down = stair.toFloor.includes("b1") || stair.label.toLowerCase().includes("ground");
    const arrowDir = up ? -1 : down ? 1 : 0;
    if (arrowDir !== 0) {
      const centerX = stair.x;
      const centerY = stair.y;
      const arrowSize = Math.min(stair.w, stair.h) * 0.25;
      g.beginPath();
      g.moveTo(centerX, centerY + arrowSize * arrowDir);
      g.lineTo(centerX, centerY - arrowSize * arrowDir);
      g.moveTo(centerX, centerY - arrowSize * arrowDir);
      g.lineTo(centerX - arrowSize * 0.55, centerY - arrowSize * 0.35 * arrowDir);
      g.moveTo(centerX, centerY - arrowSize * arrowDir);
      g.lineTo(centerX + arrowSize * 0.55, centerY - arrowSize * 0.35 * arrowDir);
      g.stroke({ color: 0x111111, width: 1.4, alpha: 0.85 });
    }

    const bracket = Math.min(10, stair.w * 0.22, stair.h * 0.22);
    const inset = 6;
    g.beginPath();
    g.moveTo(x + inset, y + inset + bracket);
    g.lineTo(x + inset, y + inset);
    g.lineTo(x + inset + bracket, y + inset);
    g.moveTo(x + stair.w - inset - bracket, y + inset);
    g.lineTo(x + stair.w - inset, y + inset);
    g.lineTo(x + stair.w - inset, y + inset + bracket);
    g.moveTo(x + inset, y + stair.h - inset - bracket);
    g.lineTo(x + inset, y + stair.h - inset);
    g.lineTo(x + inset + bracket, y + stair.h - inset);
    g.moveTo(x + stair.w - inset - bracket, y + stair.h - inset);
    g.lineTo(x + stair.w - inset, y + stair.h - inset);
    g.lineTo(x + stair.w - inset, y + stair.h - inset - bracket);
    g.stroke({ color: 0x111111, width: 1.1, alpha: 0.45 });
  }

  private drawEntryPort(g: Graphics, stair: Stair, x: number, y: number) {
    const destination = stair.toPosition;
    const direction = normalize({ x: destination.x - stair.x, y: destination.y - stair.y });
    const horizontal = stair.w >= stair.h;
    g.rect(x, y, stair.w, stair.h).fill({ color: 0xffffff, alpha: 0.94 });
    g.rect(x, y, stair.w, stair.h).stroke({ color: 0x111111, width: 1.4, alpha: 0.78 });

    g.beginPath();
    const steps = horizontal ? 7 : 6;
    for (let i = 1; i < steps; i++) {
      if (horizontal) {
        const sx = x + (stair.w / steps) * i;
        g.moveTo(sx, y + 6);
        g.lineTo(sx, y + stair.h - 6);
      } else {
        const sy = y + (stair.h / steps) * i;
        g.moveTo(x + 6, sy);
        g.lineTo(x + stair.w - 6, sy);
      }
    }
    g.stroke({ color: 0x111111, width: 0.85, alpha: 0.52 });

    g.beginPath();
    if (Math.abs(direction.x) > Math.abs(direction.y)) {
      const thresholdX = direction.x > 0 ? x + stair.w : x;
      g.moveTo(thresholdX, y - 4);
      g.lineTo(thresholdX, y + stair.h + 4);
    } else {
      const thresholdY = direction.y > 0 ? y + stair.h : y;
      g.moveTo(x - 4, thresholdY);
      g.lineTo(x + stair.w + 4, thresholdY);
    }
    g.stroke({ color: 0x111111, width: 2, alpha: 0.8 });
  }

  private drawObjects(time: number) {
    const g = this.objectLayer;
    g.clear();
    const nearest = this.nearestScanObject();
    for (const object of this.floor.objects) {
      const active = nearest?.id === object.id && this.controls.scanHeld;
      const alpha = object.scannable ? (object.completed ? 0.28 : 1) : 0.48;
      const pulse = active ? 1 + Math.sin(time / 90) * 0.18 : 1;
      if (active) {
        this.drawObjectScanPulse(g, object, pulse);
      }
      this.drawObjectGlyph(g, object, alpha);
    }
  }

  private drawObjectScanPulse(g: Graphics, object: ScanObject, pulse: number) {
    const definition = OBJECT_DEFINITIONS[object.kind];
    const rect = this.objectRect(object.rotation, definition.w, definition.h);
    const padding = (definition.scanPadding ?? 18) * pulse;
    const width = rect.w + padding * 2;
    const height = rect.h + padding * 2;
    if (definition.shape === "circle") {
      const radius = Math.max(width, height) / 2;
      g.circle(object.x, object.y, radius).stroke({ color: 0x111111, width: 1.2, alpha: 0.28 });
      this.strokeArc(g, object.x, object.y, radius + 4, -Math.PI * 0.95, -Math.PI * 0.62, 0x111111, 1.4, 0.38);
      this.strokeArc(g, object.x, object.y, radius + 4, Math.PI * 0.05, Math.PI * 0.38, 0x111111, 1.4, 0.38);
      return;
    }

    const left = object.x - width / 2;
    const top = object.y - height / 2;
    g.roundRect(left, top, width, height, 10).stroke({
      color: 0x111111,
      width: 1.1,
      alpha: 0.26,
    });
    const corner = Math.min(16, width * 0.18, height * 0.28);
    const right = left + width;
    const bottom = top + height;
    g.beginPath();
    g.moveTo(left, top + corner);
    g.lineTo(left, top);
    g.lineTo(left + corner, top);
    g.moveTo(right - corner, top);
    g.lineTo(right, top);
    g.lineTo(right, top + corner);
    g.moveTo(left, bottom - corner);
    g.lineTo(left, bottom);
    g.lineTo(left + corner, bottom);
    g.moveTo(right - corner, bottom);
    g.lineTo(right, bottom);
    g.lineTo(right, bottom - corner);
    g.stroke({ color: 0x111111, width: 1.35, alpha: 0.4 });
  }

  private drawObjectGlyph(g: Graphics, object: ScanObject, alpha: number) {
    const definition = OBJECT_DEFINITIONS[object.kind];
    const rect = this.objectRect(object.rotation, definition.w, definition.h);
    if (definition.shape === "circle") {
      g.circle(object.x, object.y, Math.max(rect.w, rect.h) / 2).stroke({
        color: 0x111111,
        width: 1.4,
        alpha,
      });
      return;
    }

    g.rect(object.x - rect.w / 2, object.y - rect.h / 2, rect.w, rect.h).stroke({
      color: 0x111111,
      width: 1.4,
      alpha,
    });
  }

  private objectRect(rotation: number | undefined, width: number, height: number) {
    return rotation === 90 ? { w: height, h: width } : { w: width, h: height };
  }

  private objectScanRadius(object: ScanObject) {
    const definition = OBJECT_DEFINITIONS[object.kind];
    const rect = this.objectRect(object.rotation, definition.w, definition.h);
    return Math.hypot(rect.w, rect.h) / 2 + (definition.scanPadding ?? 18);
  }

  private drawBench(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 72, 22);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.rect(left + 4, top + 4, rect.w - 8, rect.h - 8).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.42 });
    g.beginPath();
    if (rect.w >= rect.h) {
      for (let offset = -22; offset <= 22; offset += 22) {
        g.moveTo(x + offset, top + 4);
        g.lineTo(x + offset, top + rect.h - 4);
      }
      g.moveTo(left + 7, y);
      g.lineTo(left + rect.w - 7, y);
    } else {
      for (let offset = -22; offset <= 22; offset += 22) {
        g.moveTo(left + 4, y + offset);
        g.lineTo(left + rect.w - 4, y + offset);
      }
      g.moveTo(x, top + 7);
      g.lineTo(x, top + rect.h - 7);
    }
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.6 });
  }

  private drawLocker(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 68, 34);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.beginPath();
    const divisions = 3;
    for (let i = 1; i < divisions; i++) {
      if (rect.w >= rect.h) {
        const sx = x - rect.w / 2 + (rect.w / divisions) * i;
        g.moveTo(sx, y - rect.h / 2);
        g.lineTo(sx, y + rect.h / 2);
      } else {
        const sy = y - rect.h / 2 + (rect.h / divisions) * i;
        g.moveTo(x - rect.w / 2, sy);
        g.lineTo(x + rect.w / 2, sy);
      }
    }
    g.stroke({ color: 0x111111, width: 1, alpha });
  }

  private drawCot(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 90, 36);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    if (rect.w >= rect.h) {
      g.rect(x - rect.w / 2 + 8, y - rect.h / 2 + 6, 22, rect.h - 12).stroke({ color: 0x111111, width: 1, alpha });
    } else {
      g.rect(x - rect.w / 2 + 6, y - rect.h / 2 + 8, rect.w - 12, 22).stroke({ color: 0x111111, width: 1, alpha });
    }
  }

  private drawDesk(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 76, 42);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.rect(x - 9, y - 7, 18, 14).stroke({ color: 0x111111, width: 1, alpha });
    g.beginPath();
    g.moveTo(x + rect.w / 2 - 25, y - rect.h / 2 + 12);
    g.lineTo(x + rect.w / 2 - 9, y - rect.h / 2 + 12);
    g.moveTo(x + rect.w / 2 - 25, y - rect.h / 2 + 20);
    g.lineTo(x + rect.w / 2 - 13, y - rect.h / 2 + 20);
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.55 });
  }

  private drawCounter(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 96, 32);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.beginPath();
    if (rect.w >= rect.h) {
      g.moveTo(x - rect.w / 2 + 12, y);
      g.lineTo(x + rect.w / 2 - 12, y);
    } else {
      g.moveTo(x, y - rect.h / 2 + 12);
      g.lineTo(x, y + rect.h / 2 - 12);
    }
    g.stroke({ color: 0x111111, width: 1, alpha });
    if (rect.w >= rect.h) {
      g.rect(x - rect.w / 2 + 12, y - 9, 22, 18).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.7 });
      g.circle(x + rect.w / 2 - 25, y, 6).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.7 });
    } else {
      g.rect(x - 9, y - rect.h / 2 + 12, 18, 22).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.7 });
      g.circle(x, y + rect.h / 2 - 25, 6).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.7 });
    }
  }

  private drawShelf(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 92, 28);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.beginPath();
    for (let i = -1; i <= 1; i++) {
      if (rect.w >= rect.h) {
        g.moveTo(x + i * 24, y - rect.h / 2);
        g.lineTo(x + i * 24, y + rect.h / 2);
      } else {
        g.moveTo(x - rect.w / 2, y + i * 24);
        g.lineTo(x + rect.w / 2, y + i * 24);
      }
    }
    g.stroke({ color: 0x111111, width: 1, alpha });
  }

  private drawCrate(g: Graphics, x: number, y: number, _rotation: number | undefined, alpha: number) {
    g.rect(x - 22, y - 22, 44, 44).stroke({ color: 0x111111, width: 1.8, alpha });
    g.beginPath();
    g.moveTo(x - 22, y - 22);
    g.lineTo(x + 22, y + 22);
    g.moveTo(x + 22, y - 22);
    g.lineTo(x - 22, y + 22);
    g.stroke({ color: 0x111111, width: 1, alpha: alpha * 0.72 });
  }

  private drawTable(g: Graphics, x: number, y: number, alpha: number) {
    g.circle(x, y, 24).stroke({ color: 0x111111, width: 1.8, alpha });
    g.circle(x - 36, y, 5).stroke({ color: 0x111111, width: 1, alpha });
    g.circle(x + 36, y, 5).stroke({ color: 0x111111, width: 1, alpha });
    g.circle(x, y - 36, 5).stroke({ color: 0x111111, width: 1, alpha });
    g.circle(x, y + 36, 5).stroke({ color: 0x111111, width: 1, alpha });
  }

  private drawDiningTable(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 112, 62);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    const tableW = rect.w >= rect.h ? rect.w - 34 : rect.w - 18;
    const tableH = rect.w >= rect.h ? rect.h - 28 : rect.h - 34;
    const tableLeft = x - tableW / 2;
    const tableTop = y - tableH / 2;
    g.rect(tableLeft, tableTop, tableW, tableH).stroke({ color: 0x111111, width: 1.8, alpha });
    g.rect(tableLeft + 8, tableTop + 8, tableW - 16, tableH - 16).stroke({
      color: 0x111111,
      width: 0.8,
      alpha: alpha * 0.38,
    });

    g.beginPath();
    g.moveTo(x - tableW * 0.18, y);
    g.lineTo(x + tableW * 0.18, y);
    g.moveTo(x, y - tableH * 0.18);
    g.lineTo(x, y + tableH * 0.18);
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.42 });

    const chairW = rect.w >= rect.h ? 16 : 18;
    const chairH = rect.w >= rect.h ? 22 : 16;
    if (rect.w >= rect.h) {
      for (const offset of [-30, 0, 30]) {
        g.rect(x + offset - chairW / 2, top + 2, chairW, chairH).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.82 });
        g.rect(x + offset - chairW / 2, top + rect.h - chairH - 2, chairW, chairH).stroke({
          color: 0x111111,
          width: 1,
          alpha: alpha * 0.82,
        });
      }
    } else {
      for (const offset of [-30, 0, 30]) {
        g.rect(left + 2, y + offset - chairH / 2, chairW, chairH).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.82 });
        g.rect(left + rect.w - chairW - 2, y + offset - chairH / 2, chairW, chairH).stroke({
          color: 0x111111,
          width: 1,
          alpha: alpha * 0.82,
        });
      }
    }
  }

  private drawServerRack(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 80, 34);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.beginPath();
    for (let offset = -24; offset <= 24; offset += 16) {
      if (rect.w >= rect.h) {
        g.moveTo(x + offset, y - 7);
        g.lineTo(x + offset + 6, y - 7);
        g.moveTo(x + offset, y + 7);
        g.lineTo(x + offset + 6, y + 7);
      } else {
        g.moveTo(x - 7, y + offset);
        g.lineTo(x - 7, y + offset + 6);
        g.moveTo(x + 7, y + offset);
        g.lineTo(x + 7, y + offset + 6);
      }
    }
    g.stroke({ color: 0x111111, width: 1, alpha });
  }

  private drawSofa(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 82, 38);
    g.rect(x - rect.w / 2, y - rect.h / 2, rect.w, rect.h).stroke({ color: 0x111111, width: 1.8, alpha });
    g.rect(x - rect.w / 2 + 8, y - rect.h / 2 + 8, rect.w - 16, rect.h - 16).stroke({
      color: 0x111111,
      width: 1,
      alpha: alpha * 0.75,
    });
    g.beginPath();
    if (rect.w >= rect.h) {
      g.moveTo(x, y - rect.h / 2 + 8);
      g.lineTo(x, y + rect.h / 2 - 8);
      g.moveTo(x - rect.w / 2 + 8, y + rect.h / 2 - 8);
      g.lineTo(x + rect.w / 2 - 8, y + rect.h / 2 - 8);
    } else {
      g.moveTo(x - rect.w / 2 + 8, y);
      g.lineTo(x + rect.w / 2 - 8, y);
      g.moveTo(x + rect.w / 2 - 8, y - rect.h / 2 + 8);
      g.lineTo(x + rect.w / 2 - 8, y + rect.h / 2 - 8);
    }
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.58 });
  }

  private drawCar(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 48, 88);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.roundRect(left, top, rect.w, rect.h, 10).stroke({ color: 0x111111, width: 1.6, alpha });
    g.roundRect(left + rect.w * 0.2, top + rect.h * 0.18, rect.w * 0.6, rect.h * 0.24, 4).stroke({
      color: 0x111111,
      width: 1,
      alpha: alpha * 0.7,
    });
    g.roundRect(left + rect.w * 0.2, top + rect.h * 0.6, rect.w * 0.6, rect.h * 0.22, 4).stroke({
      color: 0x111111,
      width: 1,
      alpha: alpha * 0.7,
    });
    g.beginPath();
    if (rect.h >= rect.w) {
      g.moveTo(left + 8, top + 12);
      g.lineTo(left + 8, top + rect.h - 12);
      g.moveTo(left + rect.w - 8, top + 12);
      g.lineTo(left + rect.w - 8, top + rect.h - 12);
    } else {
      g.moveTo(left + 12, top + 8);
      g.lineTo(left + rect.w - 12, top + 8);
      g.moveTo(left + 12, top + rect.h - 8);
      g.lineTo(left + rect.w - 12, top + rect.h - 8);
    }
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.55 });
  }

  private drawBed(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 78, 46);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.7, alpha });
    if (rect.w >= rect.h) {
      g.rect(left + 7, top + 7, 18, rect.h - 14).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.78 });
      g.beginPath();
      g.moveTo(left + rect.w * 0.48, top + 6);
      g.lineTo(left + rect.w * 0.48, top + rect.h - 6);
      g.moveTo(left + rect.w * 0.68, top + 8);
      g.lineTo(left + rect.w * 0.68, top + rect.h - 8);
      g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.55 });
    } else {
      g.rect(left + 7, top + 7, rect.w - 14, 18).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.78 });
      g.beginPath();
      g.moveTo(left + 6, top + rect.h * 0.48);
      g.lineTo(left + rect.w - 6, top + rect.h * 0.48);
      g.moveTo(left + 8, top + rect.h * 0.68);
      g.lineTo(left + rect.w - 8, top + rect.h * 0.68);
      g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.55 });
    }
  }

  private drawKitchenIsland(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 112, 42);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.7, alpha });
    if (rect.w >= rect.h) {
      g.rect(left + 10, top + 8, 26, rect.h - 16).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.75 });
      g.circle(left + rect.w - 40, y, 8).stroke({ color: 0x111111, width: 1, alpha });
      g.circle(left + rect.w - 18, y, 8).stroke({ color: 0x111111, width: 1, alpha });
    } else {
      g.rect(left + 8, top + 10, rect.w - 16, 26).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.75 });
      g.circle(x, top + rect.h - 40, 8).stroke({ color: 0x111111, width: 1, alpha });
      g.circle(x, top + rect.h - 18, 8).stroke({ color: 0x111111, width: 1, alpha });
    }
  }

  private drawVendingMachine(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 34, 70);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.7, alpha });
    if (rect.h >= rect.w) {
      g.rect(left + 6, top + 7, rect.w - 12, rect.h * 0.46).stroke({ color: 0x111111, width: 0.9, alpha: alpha * 0.74 });
      g.rect(left + rect.w - 12, top + rect.h * 0.58, 6, 12).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.68 });
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const py = top + 15 + i * 9;
        g.moveTo(left + 10, py);
        g.lineTo(left + rect.w - 10, py);
      }
      g.stroke({ color: 0x111111, width: 0.65, alpha: alpha * 0.52 });
    } else {
      g.rect(left + 7, top + 6, rect.w * 0.46, rect.h - 12).stroke({ color: 0x111111, width: 0.9, alpha: alpha * 0.74 });
      g.rect(left + rect.w * 0.58, top + rect.h - 12, 12, 6).stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.68 });
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const px = left + 15 + i * 9;
        g.moveTo(px, top + 10);
        g.lineTo(px, top + rect.h - 10);
      }
      g.stroke({ color: 0x111111, width: 0.65, alpha: alpha * 0.52 });
    }
  }

  private drawRoundPlanter(g: Graphics, x: number, y: number, alpha: number) {
    g.circle(x, y, 23).stroke({ color: 0x111111, width: 1.5, alpha });
    g.circle(x, y, 15).stroke({ color: 0x111111, width: 0.85, alpha: alpha * 0.44 });
    this.drawLeafGlyph(g, x, y, 12, alpha * 0.72);
  }

  private drawWashroom(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 64, 46);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.5, alpha });
    g.circle(left + rect.w * 0.28, y, 8).stroke({ color: 0x111111, width: 1, alpha });
    g.rect(left + rect.w * 0.56, top + 8, rect.w * 0.28, rect.h - 16).stroke({
      color: 0x111111,
      width: 1,
      alpha: alpha * 0.75,
    });
    g.beginPath();
    g.moveTo(left + rect.w * 0.42, top + 8);
    g.lineTo(left + rect.w * 0.42, top + rect.h - 8);
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.45 });
  }

  private drawArmchair(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 38, 34);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.6, alpha });
    g.rect(left + 7, top + 7, rect.w - 14, rect.h - 10).stroke({ color: 0x111111, width: 1, alpha: alpha * 0.7 });
    if (rect.w >= rect.h) {
      g.beginPath();
      g.moveTo(left + 7, top + rect.h - 7);
      g.lineTo(left + rect.w - 7, top + rect.h - 7);
    } else {
      g.beginPath();
      g.moveTo(left + rect.w - 7, top + 7);
      g.lineTo(left + rect.w - 7, top + rect.h - 7);
    }
    g.stroke({ color: 0x111111, width: 1, alpha: alpha * 0.62 });
  }

  private drawFileCabinet(g: Graphics, x: number, y: number, rotation: number | undefined, alpha: number) {
    const rect = this.objectRect(rotation, 48, 28);
    const left = x - rect.w / 2;
    const top = y - rect.h / 2;
    g.rect(left, top, rect.w, rect.h).stroke({ color: 0x111111, width: 1.6, alpha });
    g.beginPath();
    const count = 3;
    for (let i = 1; i < count; i++) {
      if (rect.w >= rect.h) {
        const sx = left + (rect.w / count) * i;
        g.moveTo(sx, top);
        g.lineTo(sx, top + rect.h);
      } else {
        const sy = top + (rect.h / count) * i;
        g.moveTo(left, sy);
        g.lineTo(left + rect.w, sy);
      }
    }
    g.stroke({ color: 0x111111, width: 0.8, alpha: alpha * 0.72 });
  }

  private drawDots() {
    const g = this.dotLayer;
    g.clear();
    for (const dot of this.floor.dots) {
      const progress = dot.capturedMs / dot.captureMs;
      g.circle(dot.x, dot.y, dot.radius).fill({ color: DOT_COLORS[dot.type] });
      if (progress > 0) {
        this.strokeArc(
          g,
          dot.x,
          dot.y,
          dot.radius + 5,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * progress,
          DOT_COLORS[dot.type],
          3,
        );
      }
    }
  }

  private drawBots(time: number) {
    const g = this.botLayer;
    g.clear();
    const player = this.playerPosition();
    this.drawDotBot(g, player.x, player.y, DOTBOT_COLOR, this.shields, this.maxShields, "alive", this.inventory[0]);

    for (const bot of this.bots) {
      if (bot.floor !== this.floor.id || bot.state === "consumed") continue;
      this.drawDotBot(g, bot.x, bot.y, bot.color, bot.shields, bot.maxShields, bot.state, bot.inventory[0]);
      if (bot.channelMs > 0 && bot.state === "downed") {
        const targetMs = bot.id.includes("teammate") ? REVIVE_MS : CONSUME_MS;
        const color = bot.id.includes("teammate") ? 0x2f80ed : 0xf05252;
        this.strokeArc(
          g,
          bot.x,
          bot.y,
          25,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * (bot.channelMs / targetMs),
          color,
          4,
        );
      }
      if (bot.state === "downed") {
        const wobble = Math.sin(time / 220) * 2;
        g.circle(bot.x, bot.y, 7 + wobble).fill({ color: bot.color, alpha: 0.4 });
      }
    }
  }

  private drawDotBot(
    g: Graphics,
    x: number,
    y: number,
    color: number,
    shields: number,
    maxShields: number,
    state: BotState,
    activeDot?: DotType,
  ) {
    const shieldRadius = 18;
    const gap = Math.PI * 0.08;
    const segment = (Math.PI * 2) / maxShields;

    for (let i = 0; i < maxShields; i++) {
      const start = -Math.PI / 2 + i * segment + gap / 2;
      const end = -Math.PI / 2 + (i + 1) * segment - gap / 2;
      const filled = i < shields;
      this.strokeArc(
        g,
        x,
        y,
        shieldRadius,
        start,
        end,
        filled ? color : 0x9ca3af,
        filled ? 4 : 1.5,
        state === "downed" ? 0.72 : 1,
      );
    }

    g.circle(x, y, 13).stroke({
      color: state === "downed" ? 0x9ca3af : color,
      width: 1,
      alpha: state === "downed" ? 0.55 : 0.3,
    });

    if (activeDot && state === "alive") {
      g.circle(x, y, 9).fill({ color: DOT_COLORS[activeDot] });
      g.circle(x, y, 13).stroke({ color: 0x111111, width: 1, alpha: 0.3 });
    } else {
      g.circle(x, y, 4).fill({ color, alpha: state === "downed" ? 0.45 : 0.7 });
    }
  }

  private strokeArc(
    g: Graphics,
    x: number,
    y: number,
    radius: number,
    start: number,
    end: number,
    color: number,
    width: number,
    alpha = 1,
  ) {
    g.beginPath();
    g.moveTo(x + Math.cos(start) * radius, y + Math.sin(start) * radius);
    g.arc(x, y, radius, start, end);
    g.stroke({ color, width, alpha });
  }

  private drawFx(time: number) {
    const g = this.fxLayer;
    g.clear();
    if (this.dashMs > 0) {
      const player = this.playerPosition();
      g.circle(player.x, player.y, PLAYER_RADIUS + 15 + Math.sin(time / 45) * 3).stroke({
        color: DOT_COLORS.dash,
        width: 2,
        alpha: 0.42,
      });
    }
  }

  private addMapLabel(label: string, x: number, y: number, size: number) {
    const text = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: "Inter, Arial, sans-serif",
        fontSize: size,
        fontWeight: "700",
        fill: 0x111111,
        letterSpacing: 1.2,
      }),
    });
    text.x = x;
    text.y = y;
    this.labels.addChild(text);
  }

  private publishHud(force: boolean) {
    const scanTarget = this.nearestScanObject();
    const stair = this.activeStair();
    const consume = this.bots
      .filter((bot) => bot.floor === this.floor.id && bot.state === "downed" && !bot.id.includes("teammate"))
      .reduce((max, bot) => Math.max(max, bot.channelMs / CONSUME_MS), 0);
    const revive = this.bots
      .filter((bot) => bot.floor === this.floor.id && bot.state === "downed" && bot.id.includes("teammate"))
      .reduce((max, bot) => Math.max(max, bot.channelMs / REVIVE_MS), 0);

    if (force || true) {
      this.onHud({
        floorLabel: this.floor.label,
        shields: this.shields,
        maxShields: this.maxShields,
        inventory: [...this.inventory],
        message: this.message,
        nearScan: Boolean(scanTarget),
        nearStairs: Boolean(stair),
        scanProgress: scanTarget ? scanTarget.scannedMs / scanTarget.scanMs : 0,
        consumeProgress: consume,
        reviveProgress: revive,
        repairCooldownMs: this.repairCooldownMs,
      });
    }
  }
}

const initialHud: HudState = {
  floorLabel: "MERCY CLINIC / GROUND",
  shields: 3,
  maxShields: 3,
  inventory: ["dash", "regen"],
  message: "Loading DotBot...",
  nearScan: false,
  nearStairs: false,
  scanProgress: 0,
  consumeProgress: 0,
  reviveProgress: 0,
  repairCooldownMs: 0,
};

export function GameCanvas() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<DotBotGame | null>(null);
  const controlsRef = useRef<GameControls>({ move: { x: 0, y: 0 }, scanHeld: false });
  const keysRef = useRef(new Set<string>());
  const [hud, setHud] = useState<HudState>(initialHud);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let app: Application | null = null;
    let cancelled = false;

    async function boot() {
      await RAPIER.init();
      if (!hostRef.current || cancelled) return;

      app = new Application();
      await app.init({
        resizeTo: hostRef.current,
        background: "#ffffff",
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
      });
      if (!hostRef.current || cancelled) {
        app.destroy(true);
        return;
      }

      hostRef.current.appendChild(app.canvas);
      const game = new DotBotGame(app, controlsRef.current, setHud);
      gameRef.current = game;
      app.ticker.add((ticker) => game.tick(ticker));
      setLoading(false);
    }

    boot();

    return () => {
      cancelled = true;
      gameRef.current?.destroy();
      gameRef.current = null;
      app?.destroy(true);
    };
  }, []);

  useEffect(() => {
    const updateKeys = () => {
      const keys = keysRef.current;
      const move = {
        x: (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0),
        y: (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0),
      };
      controlsRef.current.move = len(move) > 0 ? normalize(move) : { x: 0, y: 0 };
    };

    const onKeyDown = (event: KeyboardEvent) => {
      keysRef.current.add(event.code);
      if (event.code === "Space") controlsRef.current.scanHeld = true;
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") gameRef.current?.triggerDash();
      if (event.code === "KeyR") gameRef.current?.triggerRepair();
      if (event.code === "KeyF") gameRef.current?.useStairs();
      updateKeys();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(event.code);
      if (event.code === "Space") controlsRef.current.scanHeld = false;
      updateKeys();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const setJoystick = (clientX: number, clientY: number) => {
    const el = joystickRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const raw = { x: clientX - center.x, y: clientY - center.y };
    const max = rect.width * 0.38;
    const deadzone = rect.width * 0.13;
    const length = Math.min(max, len(raw));
    const direction = normalize(raw);
    const visual = { x: direction.x * length, y: direction.y * length };
    const analog = length <= deadzone ? 0 : Math.pow((length - deadzone) / (max - deadzone), 1.45);
    controlsRef.current.move = analog > 0 ? { x: direction.x * analog, y: direction.y * analog } : { x: 0, y: 0 };
    el.style.setProperty("--jx", `${visual.x}px`);
    el.style.setProperty("--jy", `${visual.y}px`);
  };

  const resetJoystick = () => {
    controlsRef.current.move = { x: 0, y: 0 };
    joystickRef.current?.style.setProperty("--jx", "0px");
    joystickRef.current?.style.setProperty("--jy", "0px");
  };

  const inventoryDots = hud.inventory.slice(0, 9);
  const loadoutRows = [
    { id: "you", color: DOT_COLORS.dash, shields: hud.shields },
    { id: "green", color: DOT_COLORS.regen, shields: 3 },
    { id: "yellow", color: DOT_COLORS.scanner, shields: 2 },
    { id: "purple", color: DOT_COLORS.decoy, shields: 3 },
  ];

  return (
    <section className="game-root" aria-label="DotBot mechanics prototype">
      <div ref={hostRef} className="game-canvas-host" />
      {loading ? <div className="loading">Loading DotBot</div> : null}

      <div className="hud">
        <div className="top-left" aria-label="DotBot squad shields">
          <div className="loadout-stack">
            {loadoutRows.map((row) => (
              <div className="loadout-row" key={row.id}>
                <span
                  className="loadout-bot"
                  style={{ "--loadout-color": toHexColor(row.color) } as CSSProperties}
                />
                <span className="loadout-shields">
                  {Array.from({ length: 7 }).map((_, index) => (
                    <span className={`shield-pill${index < row.shields ? " filled" : ""}`} key={index} />
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="top-right">
          <div className="mini-map" aria-hidden="true">
            <span className="mini-map-dot mini-map-player" />
            <span className="mini-map-dot mini-map-blue" />
            <span className="mini-map-dot mini-map-green" />
            <span className="mini-map-dot mini-map-yellow" />
            <span className="mini-map-dot mini-map-purple" />
            <span className="mini-map-radar" />
          </div>
          <div className="panel status-panel">
            <div className="panel-title">Status</div>
            <div>{hud.message}</div>
            {hud.consumeProgress > 0 ? <div>Consume {Math.round(hud.consumeProgress * 100)}%</div> : null}
            {hud.reviveProgress > 0 ? <div>Revive {Math.round(hud.reviveProgress * 100)}%</div> : null}
          </div>
        </div>

        <div className="bottom-right">
          <button
            className={`scan-button${hud.nearScan ? " ready" : ""}`}
            aria-label="Hold scan"
            onPointerDown={() => {
              controlsRef.current.scanHeld = true;
            }}
            onPointerUp={() => {
              controlsRef.current.scanHeld = false;
            }}
            onPointerLeave={() => {
              controlsRef.current.scanHeld = false;
            }}
          >
            <span className="scan-corners" />
            <span className="scan-core" />
            <span className="scan-badge">{Math.max(1, inventoryDots.length)}</span>
          </button>
        </div>

        <div className="dot-dock" aria-label="Run Dots">
          {[0, 1, 2, 3].map((slot) => {
            const dot = inventoryDots[slot];
            return (
              <span className={`dock-slot${dot ? " filled" : ""}`} key={slot}>
                {dot ? (
                  <span
                    className="dock-dot"
                    title={`${DOT_NAMES[dot]} Dot`}
                    style={{ background: toHexColor(DOT_COLORS[dot]) }}
                  />
                ) : null}
              </span>
            );
          })}
        </div>

        <div
          ref={joystickRef}
          className="joystick"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setJoystick(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              setJoystick(event.clientX, event.clientY);
            }
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            resetJoystick();
          }}
          onPointerCancel={resetJoystick}
        >
          <div className="joystick-thumb" />
        </div>

        <div className="help">
          WASD/arrow keys or joystick to move. Shift/Dash to hit. Space or Hold Scan near objects. Cover Dots,
          downed enemies, or downed teammates.
        </div>
      </div>
    </section>
  );
}
