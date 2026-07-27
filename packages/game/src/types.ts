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

/** A directed line segment. Visibility and geometry queries run on these. */
export type Segment = { ax: number; ay: number; bx: number; by: number };

/**
 * Anything a DotBot cannot enter.
 *
 * The world was rectangles-only because this type did not exist: every wall was
 * an axis-aligned `Rect`, so every building was a box and no wall could turn.
 * A capsule carries a wall at any angle — and a curve, as a path of them — while
 * a convex polygon carries a hull or a wedge. `rect` remains the fast path and
 * the shape all existing content is authored in.
 *
 * Concave shapes are expressed as several solids rather than one, which keeps
 * every query in `geometry.ts` exact instead of approximate.
 */
export type Solid =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "capsule"; ax: number; ay: number; bx: number; by: number; r: number }
  | { kind: "poly"; points: Vec2[] };

/**
 * A named obstacle made of one or more solids — a wall run at any angle, a
 * curved partition, a ship's hull. Authored geometry that is not a plain
 * rectangle arrives here.
 */
export type Barrier = {
  id: string;
  solids: Solid[];
};

export type BotState = "alive" | "downed" | "consumed";

export type Controller = "human" | "ai" | "frozen";

export type PowerupType = "health" | "radar" | "dashOvercharge" | "incognito";
export type DownedHostileVerb = "consume" | "reviveClean" | "lootThenRevive";

/** Compact persistence/wire codes for powerups. Blueprint cargo is excluded. */
export type WirePowerupCode = "h" | "r" | "d" | "i";
export type WireLoadoutCode = WirePowerupCode | "m";

export type LoadoutPreset = {
  name: string;
  items: WireLoadoutCode[];
};

export type Item = (
  | { kind: "powerup"; type: PowerupType }
  | { kind: "mine" }
  | { kind: "blueprint"; blueprintId: string }
) & { /** Authored building where this cargo was captured, when applicable. */ sourceBuildingId?: string };

export type ContractObjective =
  | { kind: "extractBlueprint"; blueprintId: string; buildingId: string }
  | { kind: "extractPowerups"; powerupType: PowerupType; count: number }
  | { kind: "extractFromBuilding"; buildingId: string; count: number };

export type ContractDefinition = {
  id: string;
  templateId: string;
  title: string;
  objective: ContractObjective;
  difficulty: number;
  payout: { items: Item[] };
};

export type RadarPing = Vec2 & { ageMs: number };

export type MineEntity = GameEntity & {
  placedByBotId: string;
  squadId: string;
  floorId: string;
  placedAtMs: number;
  /** Player ids with a live radar reveal; filtered before delivery. */
  revealedToBotIds: string[];
  /** Viewer-scoped presentation assigned by the protocol interest filter. */
  presentation?: "squad" | "disguised" | "revealed";
  disguise?: PowerupType;
  seam?: boolean;
};

export type HitResult = "plateBreak" | "bodyHit" | "downed";

export type SimEvent =
  | {
      type: "hit";
      botId: string;
      byBotId: string;
      /** Authoritative outcome, so presentation never has to infer a plate
       * break or down from a later snapshot. */
      result: HitResult;
      /** Contact point and away-from-attacker direction in world space. */
      position: Vec2;
      direction: Vec2;
      tick: number;
    }
  | { type: "downed"; botId: string; byBotId?: string }
  | { type: "consumed"; botId: string; byBotId: string; lostItems: Item[] }
  | { type: "revived"; botId: string; byBotId: string }
  | { type: "plea"; botId: string; squadId: string; position: Vec2; floorId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "extracted"; botId: string; squadId: string; items: Item[] }
  | { type: "mineRotated"; botId: string; mineId: string }
  | { type: "mineSensor"; botId: string; squadId: string; mineId: string; position: Vec2; floorId: string };

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

export type DoorMechanism = "automatic";

/** A gap in a wall run. A doorway can remain a permanent opening, or opt into
 * an authoritative mechanism whose art, collision, sound, and network state
 * all advance from the same simulation entity. */
export type Doorway = {
  id: string;
  /** Center of the gap. */
  x: number;
  y: number;
  width: number;
  /** Direction of the wall run the doorway sits in. */
  dir: "h" | "v";
  /**
   * The opening's true centreline. Present when the wall is not axis-aligned, in
   * which case `dir` is only the nearest-axis hint and this is authoritative.
   */
  span?: Segment;
  /** Depth of the reveal, i.e. the thickness of the wall this was cut from. */
  thickness?: number;
  /**
   * What kind of opening this is, so the renderer hangs the right furniture on it
   * rather than inferring from width — a 96-unit archway is a hole in a wall, not
   * a roll-up with a curtain and guide rails.
   */
  opening?: "door" | "rollup" | "archway";
  /** Rendered without leaf/arc (roll-up doors, open archways). */
  open?: boolean;
  /** Omit for a permanent opening or a non-interactive plan annotation. */
  mechanism?: DoorMechanism;
  /** Defaults keep public doors quick without making them visually instant. */
  openDurationMs?: number;
  holdOpenMs?: number;
  triggerRadius?: number;
  noiseLoudness?: number;
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
  /** True centreline, for glazing in a wall that is not axis-aligned. */
  span?: Segment;
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
  | "produceDisplay"
  | "floorTiles"
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
  | "planningTable"
  | "draftingTable"
  | "repairBench"
  | "listeningPost"
  | "signalMast";

/** Furniture that can be installed in the persistent player base. */
export type BaseObjectKind =
  | "fabricator"
  | "bayConsole"
  | "planningTable"
  | "draftingTable"
  | "repairBench"
  | "bed"
  | "bench"
  | "bikeRack"
  | "conferenceTable"
  | "cot"
  | "couch"
  | "counter"
  | "desk"
  | "filingCabinet"
  | "fridge"
  | "generator"
  | "locker"
  | "receptionDesk"
  | "serverRack"
  | "shelf"
  | "toolCabinet"
  | "workbench"
  | "listeningPost"
  | "signalMast";

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
  /** Architectural floor that owns this marker and any placed object. */
  floor: "GROUND" | "F1";
};

/** Sparse by design: omitted slot ids render as empty placement markers. */
export type BaseLayout = Record<string, BaseObjectKind>;

export type Facing = "N" | "S" | "E" | "W";

/** Map objects are drawn from the same authored rectangle used by physics. */
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
  /** Optional collision pieces in object-local coordinates for compound plan
   * shapes such as U counters. The visible glyph must trace the same pieces. */
  collisionParts?: Rect[];
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
  /**
   * A freestanding flight whose dashed/non-enterable half has solid side
   * rails and a solid far end. The active entry half stays open at its outer
   * end and on both sides so a bot can leave immediately after a floor change.
   * Omit when surrounding authored walls and doors already control access.
   */
  access?: "openEnd";
};

export type DotSpawn = {
  id: string;
  item: Item;
  position: Vec2;
  radius?: number;
};

/** A non-lootable world affordance used by the persistent base. */
export type InteractionDot = {
  id: string;
  kind: "object" | "emptySlot" | "deployment";
  /** Id of the MapObject, PlacementSlot, or ExtractionPoint this dot opens. */
  targetId: string;
  /** Authored floor-plan id; callers resolve GROUND through physicsFloorId. */
  floorId: string;
  position: Vec2;
  radius: number;
};

export type FloorPlan = {
  /** Globally unique, e.g. "mercy:F2". The outdoor plan uses OUTDOOR_FLOOR_ID. */
  id: string;
  label: FloorLabel;
  walls: WallSegment[];
  /**
   * Non-rectangular geometry: angled runs, curved partitions, hulls. Compiled
   * from map source; authored rect walls stay in `walls` above.
   */
  barriers?: Barrier[];
  doorways: Doorway[];
  /** Authored glazing. Windows are composed, never auto-sprayed. */
  windows?: WindowBand[];
  objects: MapObject[];
  stairs: StairLink[];
  dotSpawns: DotSpawn[];
};

export type BuildingKind = "hospital" | "office" | "retail" | "warehouse" | "residential";

export type Building = {
  id: string;
  kind: BuildingKind;
  name: string;
  /**
   * Axis-aligned bounds. Cameras, fog bounds and "which building am I in" tests
   * use this; for a non-rectangular building it is derived from `outline`, never
   * authored, and is deliberately larger than the building itself.
   */
  footprint: Rect;
  /**
   * The building's true plan shape when it is not a rectangle — an L-plan, a
   * chamfered corner, a round tower. Absent means the footprint is the shape.
   */
  outline?: Vec2[];
  /** Includes the GROUND floor. GROUND shares physics with the outdoor plane. */
  floors: FloorPlan[];
};

export type Road = Rect & {
  id: string;
};

export type ParkArea = Rect & {
  id: string;
};

/**
 * What a piece of open ground is *for*.
 *
 * Without this the exterior has exactly two states — carriageway and
 * everything-else — so the renderer fills the whole sheet with one slab and the
 * result reads as a car park with buildings dropped on it. Naming the ground is
 * what turns four boxes into a block: a footway is public and continuous, a yard
 * is back-of-house, a forecourt belongs to the door it serves.
 *
 * These are uses, not materials. The renderer decides how a yard looks; the map
 * only says that this ground is one.
 */
export type SurfaceKind =
  /** Public pavement beside a street. Derived from the street, never hand-placed. */
  | "footway"
  /** Paving that serves an entrance, and belongs to it. */
  | "forecourt"
  /** Public open paving that is a destination rather than a route. */
  | "plaza"
  /** Service hardstanding: loading, parking, bins, back-of-house. */
  | "yard"
  /** Unpaved planted setback. Walkable, but nobody routes through it. */
  | "verge";

export type Surface = Rect & {
  id: string;
  kind: SurfaceKind;
};

export type ExtractionPoint = {
  id: string;
  name: string;
  rect: Rect;
};

export type InsertionPoint = {
  id: string;
  name: string;
  position: Vec2;
  /** Defaults to the shared outdoor physics floor. */
  floorId?: string;
};

export type OutdoorPlan = {
  roads: Road[];
  parks: ParkArea[];
  /**
   * What each piece of open ground is for. Compiled from a `CityPlan` — see
   * `cityPlan.ts` — so footways cannot drift from the streets that produce them.
   */
  surfaces?: Surface[];
  /** Map edges plus anything outdoors that collides (hedges, low walls). */
  walls: WallSegment[];
  /** Non-rectangular outdoor geometry: sea walls, quaysides, cliff faces. */
  barriers?: Barrier[];
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
  insertionPoints: InsertionPoint[];
  botSpawns: BotSpawn[];
  /** Present only on maps that support slot-based furniture placement. */
  placementSlots?: PlacementSlot[];
  /** Non-lootable, floor-aware interaction affordances derived from map data. */
  interactionDots?: InteractionDot[];
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

export type DoorPhase = "closed" | "opening" | "open" | "closing";

/** Authoritative live state for one authored doorway. `blocking` is explicit
 * so clients never infer collision from a rounded animation frame. */
export type DoorEntity = {
  id: string;
  doorwayId: string;
  buildingId: string;
  floorId: string;
  position: Vec2;
  width: number;
  dir: "h" | "v";
  phase: DoorPhase;
  /** 0 closed, 1 fully open. */
  openness: number;
  blocking: boolean;
};

export type InputCommand = {
  move: Vec2;
  dash: boolean;
  useBay?: 0 | 1 | 2 | 3;
  swapBay?: { bayIndex: 0 | 1 | 2 | 3; holdIndex: number };
  downedVerb?: DownedHostileVerb;
  plea?: boolean;
};

export type CoverageKind = "capture" | "consume" | "revive" | "reviveClean" | "lootThenRevive" | "extract" | "swap";

export type NoiseKind = "dash" | "impact" | "stairs" | "channel" | "door" | "mineDetonation";

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
  mineSenseRadius: number;
  mineSensePingMs: number;
  maxActiveMines: number;
  signalIntelDurationMs: number;
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
  botSeparationSpeed: number;
  knockbackSpeed: number;
  knockbackDurationMs: number;
  shieldInvulnerabilityMs: number;
  dotCaptureDurationMs: number;
  coverDurationMs: number;
  consumeDurationMs: number;
  reviveCleanDurationMs: number;
  lootThenReviveDurationMs: number;
  pleaCooldownMs: number;
  minInsertionSpacing: number;
  respawnDelayMs: number;
  coverCenterTolerance: number;
  extractionDurationMs: number;
  runDurationMs: number;
};

export type GameSnapshot = {
  timeMs: number;
  bots: DotBotEntity[];
  dots: DotEntity[];
  mines: MineEntity[];
  coverages: CoverageSnapshot[];
  noises: NoiseEvent[];
  /** Optional only for rolling compatibility with snapshots from older rooms. */
  doors?: DoorEntity[];
  debug: {
    tickHz: number;
    tickCount: number;
    fps: number;
    activeBodies: number;
    activeDots: number;
  };
};
