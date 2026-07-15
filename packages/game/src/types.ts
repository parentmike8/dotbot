export type Vec2 = {
  x: number;
  y: number;
};

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BotState = "alive" | "downed" | "consumed";

export type Controller = "human" | "ai" | "frozen";

export type PowerupType = "health" | "radar" | "dashOvercharge" | "incognito";

export type Item =
  | { kind: "powerup"; type: PowerupType }
  | { kind: "blueprint"; blueprintId: string };

export type RadarPing = Vec2 & { ageMs: number };

export type SimEvent =
  | { type: "downed"; botId: string; byBotId?: string }
  | { type: "consumed"; botId: string; byBotId: string; lostItems: Item[] }
  | { type: "revived"; botId: string; byBotId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "extracted"; botId: string; squadId: string; items: Item[] };

// ---------------------------------------------------------------------------
// Map document model
//
// The map is pure data. The renderer interprets it; the simulation builds
// per-floor collision from it. Nothing visual lives outside this document.
// ---------------------------------------------------------------------------

export const OUTDOOR_FLOOR_ID = "outdoor";

export type FloorLabel = "GROUND" | "B1" | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "ROOF";

export type WallSegment = Rect & {
  id: string;
};

/** A gap in a wall run, recorded so the renderer can draw door leaf + swing arc. */
export type Doorway = {
  id: string;
  /** Center of the gap. */
  x: number;
  y: number;
  width: number;
  /** Direction of the wall run the doorway sits in. */
  dir: "h" | "v";
  /** Rendered without leaf/arc (roll-up doors, open archways). */
  open?: boolean;
};

/** A glazed band within a wall run. Purely visual; walls stay solid. */
export type WindowBand = {
  id: string;
  /** Center of the band. */
  x: number;
  y: number;
  length: number;
  /** Direction of the wall run the band sits in. */
  dir: "h" | "v";
};

export type ObjectKind =
  | "bed"
  | "cot"
  | "cabinet"
  | "medicalCabinet"
  | "desk"
  | "chair"
  | "table"
  | "conferenceTable"
  | "counter"
  | "receptionDesk"
  | "serverRack"
  | "shelf"
  | "filingCabinet"
  | "locker"
  | "crateStack"
  | "workbench"
  | "toolCabinet"
  | "generator"
  | "utilityBox"
  | "vending"
  | "fridge"
  | "couch"
  | "plant"
  | "planter"
  | "bench"
  | "kiosk"
  | "tree"
  | "car"
  | "bikeRack"
  | "hydrant"
  | "hvac"
  | "skylight"
  | "vent"
  | "parkingStall"
  | "lampPost"
  | "bollard"
  | "dumpster"
  | "pallet"
  | "drum"
  | "forklift"
  | "ivStand"
  | "medicalCart"
  | "coffeeStation"
  | "washer"
  | "toilet"
  | "sink"
  | "stove"
  | "column"
  | "rug"
  | "fabricator"
  | "bayConsole"
  | "planningTable";

/** Furniture that can be installed in the persistent player base. */
export type BaseObjectKind = "fabricator" | "locker" | "bayConsole" | "planningTable";

/**
 * Purely cosmetic floor-plan variants of the home base. Every shell exposes
 * the exact same placement slots (ids and zones), so no shell has a gameplay
 * advantage — the choice is layout and aesthetics only.
 */
export type BaseShellId = "workshop" | "hangar" | "berths";

export type PlacementSlot = {
  id: string;
  rect: Rect;
  zone: "wall" | "floor";
};

/** Sparse by design: omitted slot ids render as empty placement markers. */
export type BaseLayout = Record<string, BaseObjectKind>;

export type Facing = "N" | "S" | "E" | "W";

export type MapObject = {
  id: string;
  kind: ObjectKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which way the object faces (pillow end, chair side, …). Default "S". */
  facing?: Facing;
  /** Solid objects get physics colliders. Default varies by kind (see solidByDefault). */
  solid?: boolean;
  /** Scannable objects can later be scanned for Base unlocks. Data-only for now. */
  scannable?: boolean;
  /** Persistent base placement slot that materialized this object. */
  slotId?: string;
};

export type StairLink = {
  id: string;
  /** The walkable stair run. Bots walk through it; crossing the midline (the
   * architectural break line) swaps them to the linked floor — no teleport. */
  rect: Rect;
  direction: "up" | "down";
  toFloorId: string;
  /** Which side of the rect is the bottom of the flight. */
  bottom: Facing;
};

export type DotSpawn = {
  id: string;
  item: Item;
  position: Vec2;
  radius?: number;
};

export type FloorPlan = {
  /** Globally unique, e.g. "mercy:F2". The outdoor plan uses OUTDOOR_FLOOR_ID. */
  id: string;
  label: FloorLabel;
  walls: WallSegment[];
  doorways: Doorway[];
  /** Authored glazing. Windows are composed, never auto-sprayed. */
  windows?: WindowBand[];
  objects: MapObject[];
  stairs: StairLink[];
  dotSpawns: DotSpawn[];
};

export type BuildingKind = "hospital" | "office" | "warehouse" | "residential";

export type Building = {
  id: string;
  kind: BuildingKind;
  name: string;
  footprint: Rect;
  /** Includes the GROUND floor. GROUND shares physics with the outdoor plane. */
  floors: FloorPlan[];
};

export type Road = Rect & {
  id: string;
};

export type ParkArea = Rect & {
  id: string;
};

export type ExtractionPoint = {
  id: string;
  name: string;
  rect: Rect;
};

export type OutdoorPlan = {
  roads: Road[];
  parks: ParkArea[];
  /** Map edges plus anything outdoors that collides (hedges, low walls). */
  walls: WallSegment[];
  objects: MapObject[];
  dotSpawns: DotSpawn[];
};

export type BotSpawn = {
  id: string;
  name: string;
  squadId: string;
  isAmbient?: boolean;
  controller?: Controller;
  color: string;
  position: Vec2;
  floorId?: string;
  state?: BotState;
  maxShields?: number;
  shields?: number;
  bays?: (Item | null)[];
  hold?: Item[];
};

export type MapDocument = {
  id: string;
  name: string;
  width: number;
  height: number;
  outdoor: OutdoorPlan;
  buildings: Building[];
  extractionPoints: ExtractionPoint[];
  botSpawns: BotSpawn[];
  /** Present only on maps that support slot-based furniture placement. */
  placementSlots?: PlacementSlot[];
};

// ---------------------------------------------------------------------------
// Runtime entities
// ---------------------------------------------------------------------------

export type GameEntity = {
  id: string;
  position: Vec2;
  radius: number;
};

export type DotBotEntity = GameEntity & {
  name: string;
  squadId: string;
  isAmbient: boolean;
  color: string;
  state: BotState;
  floorId: string;
  /** Radians; the last direction of travel. Shield plates anchor to it. */
  facing: number;
  maxShields: number;
  /** Sum of shieldSegments, kept for HUD and AI threshold checks. */
  shields: number;
  /** Per-plate state: 1 intact, 0.5 cracked, 0 broken. Plate 0 faces forward. */
  shieldSegments: number[];
  bays: (Item | null)[];
  hold: Item[];
  /** Total carried items, authoritative even when a remote inventory is privacy-redacted. */
  carriedCount: number;
  radarActiveMs: number;
  radarPings: RadarPing[];
  dashOverchargeCharges: number;
  incognitoMs: number;
  dashCooldownMs: number;
  dashActiveMs: number;
  invulnerabilityMs: number;
};

export type DotEntity = GameEntity & {
  item: Item;
  floorId: string;
  active: boolean;
  capturedBy?: string;
  captureProgressMs: number;
};

export type InputCommand = {
  move: Vec2;
  dash: boolean;
  useBay?: 0 | 1 | 2 | 3;
  swapBay?: { bayIndex: 0 | 1 | 2 | 3; holdIndex: number };
};

export type CoverageKind = "capture" | "consume" | "revive" | "extract" | "swap";

export type NoiseKind = "dash" | "impact" | "stairs" | "channel";

/** A sound the simulation emitted; rendered as an expanding ink ring. */
export type NoiseEvent = {
  id: string;
  kind: NoiseKind;
  position: Vec2;
  /** Physics floor the sound originated on. */
  floorId: string;
  /** 0..1 — ring size, and whether the sound leaks through walls/floors. */
  loudness: number;
  ageMs: number;
  ttlMs: number;
};

export type CoverageSnapshot = {
  kind: CoverageKind;
  actorId: string;
  targetId: string;
  progressMs: number;
  durationMs: number;
};

export type GameConfig = {
  tickHz: number;
  botRadius: number;
  dotRadius: number;
  maxShields: number;
  baySlots: number;
  holdSlots: number;
  radarDurationMs: number;
  radarPingIntervalMs: number;
  radarRadius: number;
  radarPingTtlMs: number;
  dashOverchargeUses: number;
  incognitoDurationMs: number;
  powerupNoiseLoudness: number;
  swapDurationMs: number;
  blueprintLearningThreshold: number;
  playerSpeed: number;
  botSpeed: number;
  dashSpeed: number;
  dashDurationMs: number;
  dashCooldownMs: number;
  damageSpeed: number;
  shieldInvulnerabilityMs: number;
  dotCaptureDurationMs: number;
  coverDurationMs: number;
  respawnDelayMs: number;
  coverCenterTolerance: number;
  extractionDurationMs: number;
  runDurationMs: number;
};

export type GameSnapshot = {
  timeMs: number;
  bots: DotBotEntity[];
  dots: DotEntity[];
  coverages: CoverageSnapshot[];
  noises: NoiseEvent[];
  debug: {
    tickHz: number;
    tickCount: number;
    fps: number;
    activeBodies: number;
    activeDots: number;
  };
};
