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

/**
 * Two states, because nothing in this world is ever eliminated.
 *
 * There used to be a third, `consumed`: a bot another bot had finished off, which
 * for a real player meant the run was over and for an ambient grey meant a respawn
 * timer. Both are gone. A downed bot stays down until somebody revives it, so the
 * choices belong to the player who is down — wait for a squadmate, plea to be
 * picked up by another squad, or leave — rather than to whoever stood over them.
 */
export type BotState = "alive" | "downed";

export type Controller = "human" | "ai" | "frozen";

export type PowerupType = "health" | "radar" | "dashOvercharge" | "incognito";
/**
 * What you may do to a body: search what it carries, or put it back on its feet.
 *
 * There were three, and the third was a compound — loot *then* revive — which is
 * just the two in sequence and did not need its own channel. The verb that used to
 * finish a bot off has no replacement, by design.
 *
 * `loot` is the channel that *opens* a body. It moves nothing on its own: what
 * leaves the body leaves one item at a time, by `TakeCommand`, once you can see
 * what is there.
 */
export type DownedVerb = "loot" | "revive";

/**
 * Take one item off a searched body, or everything that fits.
 *
 * `index` is a flat index into `carriedItems(body)` — bays in order, then hold —
 * because that is the order the body's contents are shown in. `"all"` is not a
 * loop the client runs: one input takes what fits and leaves the rest, so a full
 * inventory cannot silently drop items on the floor.
 */
export type TakeCommand = { fromBotId: string; index: number | "all" };

/**
 * Drop one authoritative inventory slot.
 *
 * The location is accepted only while the authoritative inventory revision and
 * expected item still match. Item contents, position, floor, radius, and
 * runtime id are always derived by the simulation.
 */
export type DropCommand = {
  from: "bay" | "hold";
  index: number;
  revision: number;
  expected: Item;
};

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

/** A sampled, viewer-private Radar return. It is stale by `ageMs`, not a live body. */
export type RadarContact = Vec2 & {
  botId: string;
  floorId: string;
  ageMs: number;
};

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

/**
 * What a landed hit did. Two outcomes: the first physical contact broke a plate,
 * or the attack reached the core first and put the bot down.
 *
 * There used to be a third, `bodyHit` — a hit on bare body that cracked the
 * nearest surviving plate by half, so damage was never wasted and position never
 * decided anything. Nothing produces it now.
 */
export type HitResult = "plateBreak" | "downed";
export type DashContactResult = "bump" | "clash";

/**
 * The authoritative reason a bot went down.
 *
 * This is deliberately source-neutral. A mine can identify its device and
 * impact without handing the victim the remote owner's location; future world
 * hazards can do the same without pretending to be a bot attack.
 */
export type DownCause = {
  kind: "dash" | "ram" | "mine" | "environment";
  tick: number;
  position: Vec2;
  /** Points away from the impact source. */
  direction: Vec2;
};

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
  | {
      type: "dashContact";
      botId: string;
      byBotId: string;
      /** A point-blank, unarmed dash bumped, or two armed dashes clashed. */
      result: DashContactResult;
      position: Vec2;
      /** Points from `byBotId` toward `botId`. */
      direction: Vec2;
      tick: number;
    }
  | { type: "downed"; botId: string; byBotId?: string; cause?: DownCause }
  /** A loot channel finished: this body is open, and everyone can see it is. */
  | { type: "searched"; botId: string; byBotId: string }
  /** Items actually left this body. One event per take, `items` is what moved. */
  | { type: "looted"; botId: string; byBotId: string; items: Item[] }
  | { type: "revived"; botId: string; byBotId: string }
  /** A rival who pleaded was picked up, and changed side doing it. */
  | { type: "recruited"; botId: string; byBotId: string; fromSquadId: string; squadId: string }
  | { type: "plea"; botId: string; squadId: string; position: Vec2; floorId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "extracted"; botId: string; squadId: string; items: Item[] }
  | { type: "mineRotated"; botId: string; mineId: string }
  | { type: "mineSensor"; botId: string; squadId: string; mineId: string; position: Vec2; floorId: string }
  /** A squadmate marked a place. Delivered to that squad only. */
  | { type: "pinged"; botId: string; squadId: string; pingId: string; kind: PingKind; position: Vec2; floorId: string };

/**
 * What a squad mark means.
 *
 * Three, and plain words rather than lore: the standing rule for anything the player reads
 * is no invented terminology and no more elements than the game needs. "Here" is the
 * default because it is the one you send most and it needs no thought; the other two are
 * the two facts worth interrupting a squadmate for.
 *
 * A fourth was considered and cut. "Danger" overlaps "enemy", "regroup" overlaps "here",
 * and every extra entry costs a slot in a menu that has to be readable while being shot at.
 */
export type PingKind = "here" | "enemy" | "loot";

export const PING_KINDS: readonly PingKind[] = ["here", "enemy", "loot"];

// ---------------------------------------------------------------------------
// Map document model
//
// The map is pure data. The renderer interprets it; the simulation builds
// per-floor collision from it. Nothing visual lives outside this document.
// ---------------------------------------------------------------------------

export const OUTDOOR_FLOOR_ID = "outdoor";

export type FloorLabel = "GROUND" | "B3" | "B2" | "B1" | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "ROOF";

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
  /**
   * Progression gate. A locked mechanism still produces the authoritative live
   * door entity, drawing and collision; it simply cannot begin opening.
   */
  locked?: boolean;
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
  /** A post with a plate on it. What it says is derived from the map — see signs.ts. */
  | "sign"
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
  | "signalMast"
  /**
   * Landmarks: the objects a region is recognised by.
   *
   * Everything above is furniture — a thing inside or beside a building. These are
   * the other half of a world, and the lesson that produced them is worth keeping:
   * three regions were first drawn as ground cover (rock, scrub, water, canopy) and
   * read as nothing in particular. A place is recognised by its landmarks. A
   * turntable says railway in one glance; no amount of ballast does.
   *
   * They are ordinary ObjectKinds on purpose. Being in this union is what buys
   * collision, the Studio, the audits and the parallax pass for free — the mock
   * versions in `ui/worlds` had none of that, which is exactly why they were mock.
   */
  // Wild ground.
  | "boulder"
  | "thicket"
  | "log"
  // The rail yard.
  | "track"
  | "turntable"
  | "wagon"
  | "bufferStop"
  | "waterTank"
  | "coalingTower"
  /**
   * The fairground.
   *
   * Four attractions, and the rule that chose them is worth keeping because an
   * earlier one failed it four times: an attraction belongs here only if its
   * PLAN is its identity. A carousel is a disc of pie segments seen from above, a
   * swing ride is a ring of airborne chairs around a mast, a waltzer is a dished
   * platform with cars round the inside, and a big top is a two-peaked canvas with
   * a scalloped hem. Each of those is
   * what the thing looks like from directly overhead, so each is recognisable
   * without being told.
   *
   * `swingRide` was cut once because its seats were drawn frozen in a ring. That
   * applied the motion rule backwards: its answer is an animated, trackable ring of
   * chairs with readable backs and suspension, not deletion. `ferrisWheel` remains
   * cut: a vertical wheel seen from directly above is a LINE,
   * and every attempt to make the line read as a wheel was really an attempt to
   * borrow a side view this camera does not have.
   */
  | "carousel"
  | "swingRide"
  | "waltzer"
  | "helterSkelter"
  | "bigTop"
  // The temple.
  | "stele"
  | "altar"
  | "serpentHead"
  | "brazier";

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

export type OutdoorRuleParameter = {
  name: string;
  /** The exact token or named constant an author changes in the source file. */
  source: string;
  /** Its resolved value in this map build. */
  value: string;
};

export type OutdoorRule = {
  id: string;
  label: string;
  /** The source-form rhythm call, kept visible instead of unrolling its output. */
  expression: string;
  axis: "x" | "y";
  from: number;
  to: number;
  spacing: number;
  gaps: Array<[number, number]>;
  parameters: OutdoorRuleParameter[];
};

export type OutdoorSource =
  | {
    kind: "authored";
    file: string;
    /** Stable literal source key; inserting a neighbour cannot change it. */
    key: string;
    /** The kind is part of the locator so a stale key cannot patch another shape. */
    objectKind: ObjectKind;
    fingerprint: string;
    call: "obj";
  }
  | {
    kind: "derived";
    file: string;
    rule: OutdoorRule;
    /** Stable member identity derived from rule semantics, never array order. */
    memberKey: string;
  };

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
  /**
   * Rotation about the object's own centre, in radians. Default 0, meaning axis-aligned.
   *
   * WHY THE FORMAT NEEDED THIS. Until now an object was `x/y/w/h` plus a cardinal `facing`,
   * so nothing in the world could sit at an angle — and the world has a fan, an octagon, a
   * drum and a cross-shaped undercroft in it. In every one of them the contents were FORCED
   * to contradict the shell. The roundhouse is the clearest case: a roundhouse *is* a fan of
   * bays radiating from a turntable, because an engine cannot steer, and all three of its
   * inspection pits were axis-aligned rectangles. The file even documented the fix as done —
   * "proportioned to the direction its own bay runs" — which means the aspect ratio gestured
   * at the angle while the rectangle stayed square to the world. No audit could see it. It is
   * not carelessness, it is a gap in what the format could express.
   *
   * ONLY PASSABLE OBJECTS MAY BE ROTATED, and `compileBuilding` throws otherwise. A solid
   * object's collider is a rect or an inscribed capsule, and a rotated glyph over an
   * unrotated collider is precisely the invisible-wall lie the contract exists to prevent —
   * better to refuse it in the format than to ship a drawing that disagrees with physics.
   * Rotating solids needs poly colliders and poly-aware layout audits (`false-aisle` and
   * `wedged-fixture` both reason in rectangles, and a rotated rect has no honest one).
   *
   * `facing` is unaffected and still cardinal: it selects which END of a glyph is the head,
   * a discrete choice inside the object's own frame, and rotation then turns that frame.
   */
  angle?: number;
  /** Solid objects get physics colliders. Default varies by kind (see solidByDefault). */
  solid?: boolean;
  /**
   * Disabled runtime-capable objects keep their production glyph addressable
   * for a draw-on reveal, but contribute no visible art or collision.
   */
  enabled?: boolean;
  /** Optional collision pieces in object-local coordinates for compound plan
   * shapes such as U counters. The visible glyph must trace the same pieces. */
  collisionParts?: Rect[];
  /** Scannable objects can later be scanned for Base unlocks. Data-only for now. */
  scannable?: boolean;
  /** Persistent base placement slot that materialized this object. */
  slotId?: string;
  /**
   * Map Studio source ownership. Runtime systems ignore it; Studio uses it to
   * distinguish one literal object from the output of a placing rule.
   */
  source?: OutdoorSource;
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
  /**
   * This floor's own extent, which is usually the building's footprint and is not
   * required to be.
   *
   * It exists because a floor below ground is not bound by the mass above it. The
   * temple's undercroft runs out beyond the pyramid and under the plaza, and three
   * systems used to ask the BUILDING how big a floor was — interior line of sight,
   * the stair side-exit audit, and where an indoor bot wanders. All three answered
   * "the pyramid", so line of sight stopped at a wall that was not there, and bots
   * on the lower levels wandered toward a box they were standing outside of.
   *
   * Optional only for the player base, which builds its `Building` by hand rather
   * than through `compileBuilding`; callers fall back to the footprint.
   */
  bounds?: Rect;
  /**
   * This floor's plan, as a closed polygon — the twin of `bounds`, and needed for the
   * same reason by everything that must not treat a bounding box as a plan.
   *
   * The undercroft is a cross of galleries, so its bounding box is four fifths rock.
   * Flooding the box and calling the rest "open floor disconnected from its arrival
   * route" reported 269,760 square units of solid stone as a defect — the same blind
   * spot that made the roundhouse's fan report a phantom 18k pocket for four rounds.
   */
  outline?: Vec2[];
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

export type BuildingKind =
  | "hospital"
  | "office"
  | "retail"
  | "warehouse"
  | "residential"
  /**
   * Masonry that predates every system the other five imply.
   *
   * A pyramid and an observatory have no membrane roof, no drainage sumps, no plant
   * deck and no access hatch, and the roof pass derives all of those from a building's
   * kind. Without a kind that says "none of that", the temple's summit came out as a
   * Mayan platform with a modern flat roof laid on it — which is the loudest possible
   * version of the mistake the renderer exists to avoid, a system drawn where the
   * building below has none.
   */
  | "monument";

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
  | "verge"
  /**
   * The uses a world outside a city needs.
   *
   * These are uses, not materials, by the same test as the five above: a ritual
   * court and a shopping plaza are different things people do on different ground,
   * so they are different uses and the renderer is free to draw them differently.
   * What would be wrong is a `flagstone` kind — that is a material, and the map
   * does not get to choose one.
   */
  /** Track bed. Ballast, sleepers, the walkable ground a train runs on. */
  | "ballast"
  /** Bare trodden earth in wild land: the path, and the open ground it leads to. */
  | "clearing"
  /** Wild vegetation. Walkable, but nobody routes through it. */
  | "undergrowth"
  /** Dressed stone laid for ceremony rather than for traffic. */
  | "court"
  /**
   * Open water.
   *
   * Shallow and wadeable, which is deliberate rather than a shortcut. Water a bot
   * cannot cross needs something visible doing the stopping — a bank, a kerb, a
   * cenote rim — because invisible collision is the same lie as a ghost fixture,
   * just told the other way round. So this kind draws water and blocks nothing, and
   * every edge that must hold is authored as real solid geometry beside it.
   */
  | "water";

export type Surface = Rect & {
  id: string;
  kind: SurfaceKind;
};

/**
 * Ground whose shape is not a rectangle.
 *
 * A city can be described in rectangles because a city is built in them — a block,
 * a footway, a forecourt. Nothing outside one can: a shoreline, a clearing, the
 * apron of ballast round a turntable, the weeds taking a fairground back. Drawing
 * those as rectangles is how a "natural" region ends up reading as a city with
 * different colours, which is precisely what the first attempt at these regions did.
 *
 * Same `SurfaceKind` as a `Surface`, because the *use* is the same idea either way;
 * only the shape is freer. `auditCity` counts both, so a region cannot be used to
 * dodge the rule that every piece of ground has a named use.
 */
export type GroundRegion = {
  id: string;
  kind: SurfaceKind;
  /** Closed ring, any winding. Concave is fine; this is ground, not collision. */
  points: Vec2[];
};

export type ExtractionPoint = {
  id: string;
  name: string;
  rect: Rect;
  source?: { kind: "authored" | "composed"; file: string; note?: string };
};

export type InsertionPoint = {
  id: string;
  name: string;
  position: Vec2;
  /** Defaults to the shared outdoor physics floor. */
  floorId?: string;
  /**
   * Which region of the world this drop is in, by its display name.
   *
   * DERIVED at composition, never authored — `world.ts` stamps each region's own name as
   * it collects, so a region added later carries it with no edit anywhere. It exists
   * because the spawn picker needs to group twelve drops into four places, and the ids
   * cannot do it: the fair's and the temple's happen to be prefixed (`fair-`, `tmp-`) and
   * Downtown's are `nw-corner`, `west-gate`, `se-court` — six points with six prefixes.
   * Grouping on a naming accident would have worked for three regions out of four.
   *
   * Absent on a single-region map, where there is nothing to group.
   */
  area?: string;
  source?: { kind: "authored" | "composed"; file: string; note?: string };
};

export type OutdoorPlan = {
  roads: Road[];
  parks: ParkArea[];
  /**
   * What each piece of open ground is for. Compiled from a `CityPlan` — see
   * `cityPlan.ts` — so footways cannot drift from the streets that produce them.
   */
  surfaces?: Surface[];
  /**
   * The same thing, free of the rectangle: clearings, shorelines, track aprons.
   * Drawn after `surfaces`, so a region may deliberately lap over one — weeds
   * across a midway, ballast over a yard.
   */
  regions?: GroundRegion[];
  /** Map edges plus anything outdoors that collides (hedges, low walls). */
  walls: WallSegment[];
  /** Non-rectangular outdoor geometry: sea walls, quaysides, cliff faces. */
  barriers?: Barrier[];
  objects: MapObject[];
  dotSpawns: DotSpawn[];
};

export type BotFactionKind = "ambient" | "squad";

export type PatrolWaypoint = {
  position: Vec2;
  /** Omit for the spawn's authored floor. */
  floorId?: string;
};

export type PatrolRoute = {
  id: string;
  /** Plain-language responsibility this loop expresses in the world. */
  purpose: string;
  /** Ordered, naturally looping production navigation targets. */
  waypoints: PatrolWaypoint[];
};

export type BotSpawn = {
  id: string;
  name: string;
  squadId: string;
  /**
   * Explicit gameplay faction. `isAmbient` remains on snapshots for presentation
   * and wire compatibility; simulation hostility never infers faction from an id
   * or display name.
   */
  faction?: BotFactionKind;
  isAmbient?: boolean;
  controller?: Controller;
  color: string;
  position: Vec2;
  floorId?: string;
  /** Ambient-only authored world responsibility. Escorts never receive one. */
  patrol?: PatrolRoute;
  state?: BotState;
  maxShields?: number;
  shields?: number;
  bays?: (Item | null)[];
  hold?: Item[];
  source?: { kind: "authored" | "composed"; file: string; note?: string };
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
  /**
   * Was this body under its own power on the tick it was snapshotted?
   *
   * On the wire purely so the client predictor can mirror separation. The server
   * splits responsibility for an overlap by velocity — the mover yields, a standing
   * bot is an anchor — and it reads the ATTEMPTED velocity, so a body walking into a
   * wall counts as moving. Without this the predictor guessed from whether a
   * snapshotted position had changed, which gets that exact case backwards and
   * rubber-bands the player's own body by up to 2.5 units a tick on the contact.
   */
  moving: boolean;
  maxShields: number;
  /** Sum of shieldSegments, kept for HUD and AI threshold checks. */
  shields: number;
  /** Per-plate state: 1 intact, 0 broken. Plate 0 faces forward. */
  shieldSegments: number[];
  bays: (Item | null)[];
  hold: Item[];
  /** Increments after every authoritative inventory mutation. */
  inventoryRevision?: number;
  /** Total carried items, authoritative even when a remote inventory is privacy-redacted. */
  carriedCount: number;
  /**
   * A loot channel has finished on this body, so its contents are public and can
   * be taken without channelling again. Only ever true while downed — a revive
   * closes the body back up.
   */
  searched: boolean;
  /**
   * This body has asked to be picked up, since the last time it went down.
   *
   * The gate on joining someone else's squad. A rival can carry you only if you
   * asked — otherwise a revive would be something done TO you, and a squad you did
   * not choose is a hostage situation rather than a rescue. Cleared on going down, so
   * every down needs its own plea, and cleared on revive.
   *
   * On the wire because the overlay has to offer PICK UP on exactly the bodies the
   * simulation will accept it for; a verb the server refuses is a prompt that appears
   * and vanishes.
   */
  pleaded: boolean;
  radarActiveMs: number;
  radarPings: RadarContact[];
  dashOverchargeMs: number;
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
  /** Created during the run rather than authored in map data. */
  runtime?: true;
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

/**
 * Which bay an input refers to.
 *
 * Deliberately not a literal union of the current bay count. `0 | 1 | 2 | 3` looked
 * like a guard and was not one: it hardcoded a count that `GameConfig.baySlots`
 * owns, every call site had to cast into it — a digit parsed out of a keycode, an
 * array index — and it means nothing at all across the wire, where input arrives as
 * JSON. The range check belongs where untrusted input lands, and `Simulation` does
 * it there.
 */
export type BayIndex = number;

export type InputCommand = {
  move: Vec2;
  dash: boolean;
  useBay?: BayIndex;
  swapBay?: { bayIndex: BayIndex; holdIndex: number };
  drop?: DropCommand;
  downedVerb?: DownedVerb;
  take?: TakeCommand;
  plea?: boolean;
  /**
   * Mark a world position for your squad.
   *
   * `floorId` is absent for the live view, which marks the bot's own floor.
   * The exterior world map may explicitly request only `outdoor`; the
   * simulation rejects every explicit interior floor.
   */
  ping?: { kind: PingKind; position: Vec2; floorId?: string };
};

export type CoverageKind = "capture" | "loot" | "revive" | "extract" | "swap";

export type NoiseKind = "dash" | "impact" | "stairs" | "channel" | "door" | "mineDetonation" | "ping";

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
  dashOverchargeDurationMs: number;
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
  /** Reviving a body, friendly or not. */
  coverDurationMs: number;
  /** Stripping a body of what it carries. */
  lootDurationMs: number;
  pleaCooldownMs: number;
  pingCooldownMs: number;
  minInsertionSpacing: number;
  coverCenterTolerance: number;
  /**
   * Biggest a squad can get. Three load in; a fourth can only arrive by being picked
   * up after pleading, so the cap is what stops a run turning into one long convoy.
   */
  maxSquadSize: number;
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
  /** Viewer-authorized global count; network snapshots set it before body filtering. */
  rivalsAlive?: number;
  debug: {
    tickHz: number;
    tickCount: number;
    fps: number;
    activeBodies: number;
    activeDots: number;
  };
};
