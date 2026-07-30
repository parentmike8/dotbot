import { collectSolids, separateCircleFromRect } from "./collision";
import { buildSolidIndex, withExtraSolids, type SolidIndex, type SolidSource } from "./solidIndex";
import { rectSolid } from "./geometry";
import { buildContactShape, contactDistance, makeContactShape, type ContactShape } from "./bodyContact";
import {
  coincidentSeparationAxis,
  integrateWithWalls,
  pointSegmentDistance,
  resolveAgainstSolids,
  separationAxis,
  separationPush,
  stableHash,
} from "./kinematics";
import {
  DASH_HIT_FORGIVENESS_PX,
  DASH_START_CONTACT_EPSILON_PX,
  MOVING_SPEED,
  defaultGameConfig,
} from "./config";
import { downtownMap } from "./content/downtown";
import {
  buildingContaining,
  classifyNoise,
  contextKey,
  doorEntityCollisionRect,
  doorRuntimeId,
  doorwayCollisionRect,
  floorHeight,
  floorPlanById,
  isGroundFloor,
  objectCollisionRects,
  physicsFloorId,
  resolvePlan,
  stairConnections,
  stairExitPoint,
  stairGuardRects,
  stairHalves,
} from "./mapModel";
import { canReviveBody, canTakeFromBody, interactionDotReach, withinDownedCoverRange, withinInteractionDotRange } from "./interactions";
import { add, clamp, distance, length, normalize, normalizeInputVector, scale, subtract, zeroVec } from "./math";
import { findNavigationPath, prewarmNavigation } from "./navigation";
import { carriedCount, carriedItems, hasRoom, insertItem, removeCarriedAt } from "./inventory";
import {
  applyArmourHit,
  contactReach,
  coveringPlate,
  normalizeAngle,
  plateSum,
  platesForCount,
  restoreShieldPlate,
} from "./shields";
import { OUTDOOR_FLOOR_ID } from "./types";
import { hasLineOfSight, seesOutdoors } from "./visibility";
import type {
  BayIndex,
  BotSpawn,
  BotState,
  Building,
  Controller,
  CoverageKind,
  CoverageSnapshot,
  DoorEntity,
  Doorway,
  DotBotEntity,
  DotEntity,
  GameConfig,
  GameSnapshot,
  InputCommand,
  Item,
  MapDocument,
  MineEntity,
  NoiseEvent,
  NoiseKind,
  Rect,
  SimEvent,
  Solid,
  StairLink,
  TakeCommand,
  Vec2,
  PingKind,
} from "./types";

const NOISE_TTL_MS = 900;
const CHANNEL_PING_MS = 700;
const DOOR_BLOCKING_THRESHOLD = 0.58;
const DEFAULT_DOOR_OPEN_MS = 420;
const DEFAULT_DOOR_HOLD_MS = 1_150;
const DEFAULT_DOOR_TRIGGER_RADIUS = 112;
const DEFAULT_DOOR_NOISE = 0.42;

/** Combat rewind window: 18 ticks ≈ 300ms covers the client's interpolation
 * buffer plus a full round trip and the input queue wait, without letting
 * badly lagged attackers hit deep into the past. */
const MAX_REWIND_TICKS = 18;

/**
 * Hunters need visible daylight before committing a damaging dash. This sits
 * outside the contact test's forgiveness ring: parking inside that ring would
 * make every AI dash a point-blank bump under the run-up rule.
 *
 * The hit test and the AI's inside-contact decision deliberately share
 * `DASH_HIT_FORGIVENESS_PX`; dash-start contact does not. Treating that wider
 * hit tolerance as literal starting contact made visible daylight behave like
 * a clinch.
 */
const AI_DASH_RUN_UP_PX = DASH_HIT_FORGIVENESS_PX + 8;

/**
 * Where a bot is told to stand to work on a downed body, as a share of its
 * radius.
 *
 * 0.42 (10.08 px) was authored for a body you walk onto. Two looters at 10.08
 * from the same corpse would be 20.16 apart, and the smallest centre distance any
 * two bodies can reach is 19.20 — 48 when both present a live plate. So
 * `steerToward` never returned zero and N looters pressed inward at a fixed
 * nonzero speed forever: measured over 1800 ticks, N=2 settled 24.00 from the
 * body still commanded at 37.8 px/s, N=3 at 27.9 px / 48.5 px/s, N=4 at 33.9 px /
 * 64.8 px/s, none of them ever settling.
 *
 * 1.25 (30 px) is a ring two, and three, bodies can actually occupy, and it is
 * inside what `withinDownedCoverRange` accepts — that ceiling is
 * `actorRadius + targetRadius * 0.55` = 1.55 radii for equal bodies, so the
 * relationship holds at any radius, not just at 24. Four looters still cannot all
 * fit (they would need 33.94), and no single stand-off distance can seat six;
 * that wants a ring assignment, not a constant.
 */
const BODY_CHANNEL_STAND_OFF = 1.25;
/**
 * A stall is asking for movement and not getting it. Ninety ticks is a second and
 * a half — long enough that ordinary shouldering and a shared doorway are not a
 * stall, short enough that a jam drains before a player watching it decides the
 * game is broken.
 */
const AI_STALL_TICKS = 90;
/** Below this the request is a standing bot's rounding, not an intent to travel. */
const AI_STALL_REQUEST = 0.2;
/** A quarter of a body. Less than this over the window and it went nowhere. */
const AI_STALL_PROGRESS_PX = 6;
/** How long a stalled objective stays off this bot's list, doubled by its roll. */
const AI_STALL_AVOID_MS = 1400;
/**
 * A parry has to reset an AI duel, not synchronize it.
 *
 * Without a brief target break, two identical hunters clash once, return to
 * contact together, and then spend every ready dash on the same point-blank
 * bump forever. Each bot rolls its own recovery so one re-engages first and
 * the next exchange can deal damage.
 */
const AI_CLASH_DISENGAGE_MS = 700;
/**
 * How much room past its own radius a wedged bot tries to win back.
 *
 * The navigator wants a full `botRadius` of clearance to plan from a point, so
 * escaping to exactly that leaves the bot on the boundary and one rounding error
 * from being wedged again. A couple of units of slack makes the escape stick.
 */
const WEDGE_ESCAPE_MARGIN = 3;
/**
 * How far apart two hunters' slots are kept, whatever the target's plate state.
 *
 * Two fully plated bodies rest at 48, which is the widest any pair can ever want, so
 * this is that plus a little air. Deliberately NOT derived from the target's own
 * contact gap: the stand-off breathes with its plating and this must not, or the
 * queue tightens exactly when the crowd is biggest.
 */
const SLOT_CHORD = 62;
/** Close enough to a slot to be standing in it. */
const AI_SLOT_ARRIVAL = 6;
/** Past this a bot is travelling toward a fight, not queueing at one. */
const AI_SLOT_CLAIM_RANGE = 420;

/**
 * How long an AI squadmate keeps acting on a mark.
 *
 * Longer than the client's visual lifetime on purpose: the mark fades off your screen once
 * you have read it, but the squadmate you sent is still walking. Shorter than a run, so a
 * mark placed at insertion is not still steering somebody five minutes later.
 */
const PING_MEMORY_MS = 14_000;

/** How near a mark something has to be for the mark to be about it. */
const PING_PULL = 260;

/** Close enough to a `here` mark to count as arrived. */
const PING_ARRIVED = 56;

const NOISE_LOUDNESS = {
  dash: 0.8,
  impact: 1.0,
  stairs: 0.75,
  captureChannel: 0.5,
  coverChannel: 0.65,
  extractChannel: 0.7,
  mineDetonation: 1.0,
  /**
   * Quietest thing in the table.
   *
   * A mark is a voice, not a dash, and `classifyNoise` uses loudness to decide whether a
   * sound leaks through walls at all — so at this level it is heard by a squadmate in the
   * room and not by a rival two rooms away. Which is the point: audible enough to notice,
   * quiet enough that marking is not a beacon.
   */
  ping: 0.35,
} as const;

type InternalBot = DotBotEntity & {
  spawn: Vec2;
  spawnFloorId: string;
  desiredMove: Vec2;
  lastAim: Vec2;
  /** Velocity applied this tick (movement + knockback); combat reads this. */
  velocity: Vec2;
  /**
   * The movement half of `velocity`, without the knockback.
   *
   * The ram rule needs to know how hard a body is driving ITSELF, because a body
   * wearing a 320 px/s shove is not a body attacking — see `ramSpeedToward`.
   */
  moveVelocity: Vec2;
  knockbackVel: Vec2;
  knockbackMs: number;
  /** Position at the start of the tick, for stair midline-crossing checks. */
  prevPosition: Vec2;
  /** Recent end-of-tick positions (newest last) for combat lag compensation. */
  positionHistory: Array<{ position: Vec2; floorId: string }>;
  /** How many ticks in the past this bot perceives the world (render delay). */
  viewDelayTicks: number;
  /**
   * Hostiles already touching when this dash began. A dash needs a run-up
   * against each target; the set lasts for the dash so float jitter cannot turn
   * a point-blank bump into damage halfway through the same lunge.
   */
  dashBlockedTargets: Set<string>;
  aiWanderTarget: Vec2;
  aiRetargetMs: number;
  aiPath: Vec2[];
  /** Where the current leg started, so a waypoint can be retired on progress
   * along the leg rather than on proximity alone. See `waypointRetired`. */
  aiPathLegStart: Vec2;
  aiPathTarget: Vec2;
  aiPathFloorId: string;
  aiRepathMs: number;
  /**
   * Distance to the nearest living human, refreshed each tick. Drives how much
   * planning effort this bot is worth — see `replanInterval`.
   */
  aiAttention: number;
  aiPathProjected: boolean;
  aiAvoidTargets: Map<string, number>;
  /** Consecutive ticks of asking to move and not moving. See `noteAiStall`. */
  aiStallTicks: number;
  /** Where the current stall window started measuring from. */
  aiStallFrom: Vec2;
  /**
   * This body decomposed into convex primitives for `contactDistance`, rebuilt
   * only when the pose it was built from changes. Every candidate pair reads it
   * and there are O(n^2) of those, so building it per read cost more than the
   * contact test itself.
   */
  contactShape: ContactShape;
  shapeFacing: number;
  shapeSegments: number[];
  pleaCooldownMs: number;
  pingCooldownMs: number;
  radarPingElapsedMs: number;
  activeSwap?: { bayIndex: BayIndex; holdIndex: number; progressMs: number };
};

type InternalDot = DotEntity;

type InternalMine = MineEntity & {
  sensorElapsedMs: number;
  revealMsByBotId: Map<string, number>;
};

type ActiveCoverage = CoverageSnapshot;

type InternalDoor = DoorEntity & {
  doorway: Doorway;
  holdRemainingMs: number;
};

/** `loot` is a Dot on the ground; `strip` is a body. */
type AiIntent = "loot" | "hunt" | "revive" | "strip" | "extract" | "investigate" | "escort" | "wander";

type AiTarget = {
  position: Vec2;
  floorId: string;
  stopDistance: number;
  slowDistance: number;
  intent: AiIntent;
  projectionAllowed: boolean;
  targetId?: string;
};

type SimulationOptions = {
  map?: MapDocument;
  config?: Partial<GameConfig>;
};

export class DotBotSimulation {
  readonly config: GameConfig;
  readonly map: MapDocument;

  private readonly bots = new Map<string, InternalBot>();
  private readonly controllers = new Map<string, Controller>();
  private readonly inputs = new Map<string, InputCommand>();
  /**
   * Squad marks, newest first, one per kind per squad. AI memory only — see `pingFor`.
   * Never on the snapshot: a mark has no authority in the world.
   */
  private squadMarks: Array<{
    squadId: string;
    kind: PingKind;
    position: Vec2;
    floorId: string;
    atMs: number;
  }> = [];
  private readonly dots = new Map<string, InternalDot>();
  private readonly mines = new Map<string, InternalMine>();
  private readonly coverages = new Map<string, ActiveCoverage>();
  private readonly doors = new Map<string, InternalDoor>();
  /** Everything static a bot collides with, per physics floor. */
  private readonly staticSolids = new Map<string, Solid[]>();
  /**
   * The same geometry, gridded. Built once per plane beside `staticSolids` so the
   * hot movement loop tests a handful of candidates instead of the whole plane —
   * see `solidIndex.ts` for why that is bit-identical rather than merely close.
   */
  private readonly solidIndexes = new Map<string, SolidIndex>();
  /** Stairs per physics floor. */
  private readonly stairsByFloor = new Map<string, StairLink[]>();
  private disposed = false;
  private events: SimEvent[] = [];
  private timeMs = 0;
  private tickCount = 0;
  private fps = 0;
  private rngState = 481516234;
  /** Which bot, if any, may run A* this tick. See `grantPlanningPermit`. */
  private planPermit: string | null = null;
  private noises: NoiseEvent[] = [];
  private noiseSeq = 0;
  private mineSeq = 0;

  private constructor(map: MapDocument, config: GameConfig) {
    this.map = map;
    this.config = config;
    this.buildStaticCollision();
    this.collectStairs();
    this.collectDoors();

    for (const spawn of map.botSpawns) {
      this.spawnBot(spawn, spawn.controller ?? "ai");
    }

    this.spawnDots();
  }

  static async create(options: SimulationOptions = {}): Promise<DotBotSimulation> {
    const config = { ...defaultGameConfig, ...options.config };
    const map = options.map ?? downtownMap;

    // Navigation graph construction is intentionally paid during the async
    // loading boundary, never in the first live AI tick.
    prewarmNavigation(map, config.botRadius);

    return new DotBotSimulation(map, config);
  }

  // ---------------------------------------------------------------------------
  // World construction
  // ---------------------------------------------------------------------------

  /**
   * Static collision, taken from the same `collectSolids` every other system
   * reads: client prediction, navigation clearance and line of sight.
   *
   * This used to walk the map itself, adding `floor.walls` and object rects. That
   * made it a second, independent answer to "what is solid here" — and the moment
   * a wall could be something other than a rectangle, the two answers diverged:
   * every path wall was solid to the client and thin air to the server, so an
   * entire building's shell was walk-through while the client kept predicting a
   * wall. One function, one answer.
   */
  private buildStaticCollision(): void {
    const physicsIds = new Set<string>([OUTDOOR_FLOOR_ID]);
    for (const building of this.map.buildings) {
      for (const floor of building.floors) physicsIds.add(physicsFloorId(this.map, floor.id));
    }
    for (const id of physicsIds) {
      const solids = collectSolids(this.map, id);
      this.staticSolids.set(id, solids);
      this.solidIndexes.set(id, buildSolidIndex(solids));
    }
  }

  private collectStairs(): void {
    for (const building of this.map.buildings) {
      for (const floor of building.floors) {
        const key = physicsFloorId(this.map, floor.id);
        const stairs = this.stairsByFloor.get(key) ?? [];
        stairs.push(...floor.stairs);
        this.stairsByFloor.set(key, stairs);
      }
    }
  }

  private collectDoors(): void {
    for (const building of this.map.buildings) {
      for (const floor of building.floors) {
        for (const doorway of floor.doorways) {
          if (!doorway.mechanism) continue;
          const floorId = physicsFloorId(this.map, floor.id);
          const id = doorRuntimeId(floor.id, doorway.id);
          this.doors.set(id, {
            id,
            doorwayId: doorway.id,
            buildingId: building.id,
            floorId,
            position: { x: doorway.x, y: doorway.y },
            width: doorway.width,
            dir: doorway.dir,
            phase: "closed",
            openness: 0,
            blocking: true,
            doorway,
            holdRemainingMs: 0,
          });
        }
      }
    }
  }

  private spawnDots(): void {
    const register = (floorId: string, spawns: typeof this.map.outdoor.dotSpawns, sourceBuildingId?: string) => {
      for (const spawn of spawns) {
        this.dots.set(spawn.id, {
          id: spawn.id,
          position: { ...spawn.position },
          radius: spawn.radius ?? this.config.dotRadius,
          item: { ...spawn.item, sourceBuildingId: spawn.item.sourceBuildingId ?? sourceBuildingId },
          floorId,
          active: true,
          captureProgressMs: 0,
        });
      }
    };

    register(OUTDOOR_FLOOR_ID, this.map.outdoor.dotSpawns);

    for (const building of this.map.buildings) {
      for (const floor of building.floors) {
        register(physicsFloorId(this.map, floor.id), floor.dotSpawns, building.id);
      }
    }
  }

  spawnBot(spawn: BotSpawn, controller: Controller): string {
    if (this.bots.has(spawn.id)) {
      throw new Error(`Bot already exists: ${spawn.id}`);
    }

    const maxShields = spawn.maxShields ?? this.config.maxShields;
    const state = spawn.state ?? "alive";
    const shields = spawn.shields ?? (state === "alive" ? maxShields : 0);
    const floorId = physicsFloorId(this.map, spawn.floorId ?? OUTDOOR_FLOOR_ID);
    // Bots have never lived in a contact solver: movement, walls and bot
    // separation all resolve through the shared kinematics module, which the
    // client predictor runs verbatim. Solver contacts gave unbounded shoves,
    // deep interpenetration, and pushable corpses.
    const shieldSegments = platesForCount(maxShields, shields);
    const bot: InternalBot = {
      id: spawn.id,
      name: spawn.name,
      squadId: spawn.squadId,
      isAmbient: spawn.isAmbient ?? false,
      color: spawn.color,
      position: { ...spawn.position },
      radius: this.config.botRadius,
      state,
      floorId,
      facing: 0,
      moving: false,
      maxShields,
      shields: plateSum(shieldSegments),
      shieldSegments,
      bays: normalizedBays(spawn, this.config),
      hold: spawn.isAmbient ? [] : (spawn.hold ?? []).slice(0, this.config.holdSlots),
      carriedCount: 0,
      searched: false,
      pleaded: false,
      radarActiveMs: 0,
      radarPings: [],
      radarPingElapsedMs: 0,
      dashOverchargeCharges: 0,
      incognitoMs: 0,
      dashCooldownMs: 0,
      dashActiveMs: 0,
      invulnerabilityMs: 0,
      spawn: { ...spawn.position },
      spawnFloorId: floorId,
      desiredMove: zeroVec(),
      lastAim: { x: 1, y: 0 },
      velocity: zeroVec(),
      moveVelocity: zeroVec(),
      knockbackVel: zeroVec(),
      knockbackMs: 0,
      prevPosition: { ...spawn.position },
      positionHistory: [],
      viewDelayTicks: 0,
      dashBlockedTargets: new Set(),
      aiWanderTarget: { ...spawn.position },
      aiRetargetMs: 0,
      aiPath: [],
      aiPathLegStart: { ...spawn.position },
      aiPathTarget: { ...spawn.position },
      aiPathFloorId: floorId,
      aiRepathMs: 0,
      aiAttention: 0,
      aiPathProjected: false,
      aiAvoidTargets: new Map(),
      aiStallTicks: 0,
      aiStallFrom: { ...spawn.position },
      contactShape: makeContactShape(maxShields),
      // NaN, so the first read always builds rather than trusting a zero that
      // happens to match a bot facing due east.
      shapeFacing: Number.NaN,
      shapeSegments: [],
      pleaCooldownMs: 0,
      pingCooldownMs: 0,
    };

    this.bots.set(bot.id, bot);
    this.controllers.set(bot.id, controller);
    this.inputs.set(bot.id, { move: zeroVec(), dash: false });
    return bot.id;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  applyInput(botId: string, input: InputCommand): void {
    if (!this.bots.has(botId) || this.controllers.get(botId) !== "human") {
      return;
    }

    const current = this.inputs.get(botId);
    this.inputs.set(botId, {
      move: normalizeInputVector(input.move),
      dash: (current?.dash ?? false) || input.dash,
      useBay: current?.useBay ?? input.useBay,
      swapBay: current?.swapBay ?? input.swapBay,
      downedVerb: input.downedVerb,
      take: current?.take ?? input.take,
      plea: (current?.plea ?? false) || input.plea,
      ping: current?.ping ?? input.ping,
    });
  }

  /**
   * Lag compensation: how far in the past this bot's player perceives other
   * bots (interpolation delay + half RTT, reported by the client and clamped
   * here). Dash hits test the victim at the attacker's perceived time, so
   * aiming at what you see on screen connects.
   */
  setViewDelayTicks(botId: string, ticks: number): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }
    bot.viewDelayTicks = clamp(Math.round(ticks), 0, MAX_REWIND_TICKS);
  }

  setController(botId: string, controller: Controller): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }

    this.controllers.set(botId, controller);
    if (controller === "frozen") {
      bot.desiredMove = zeroVec();
      bot.velocity = zeroVec();
    }
  }

  removeBot(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }

    this.bots.delete(botId);
    this.controllers.delete(botId);
    this.inputs.delete(botId);

    for (const [key, coverage] of this.coverages) {
      if (coverage.actorId === botId || coverage.targetId === botId) {
        this.coverages.delete(key);
      }
    }

    for (const dot of this.dots.values()) {
      if (dot.capturedBy === botId) {
        dot.capturedBy = undefined;
      }
    }

    for (const other of this.bots.values()) {
      other.aiAvoidTargets.delete(botId);
    }
  }

  drainEvents(): SimEvent[] {
    return this.events.splice(0);
  }

  setMeasuredFps(fps: number): void {
    this.fps = fps;
  }

  step(): void {
    if (this.disposed) {
      return;
    }

    const dtSeconds = 1 / this.config.tickHz;
    const dtMs = dtSeconds * 1000;

    this.timeMs += dtMs;
    this.tickCount += 1;

    this.ageNoises(dtMs);
    this.updateTimers(dtMs);
    this.updateDoors(dtMs);

    for (const bot of this.bots.values()) {
      bot.prevPosition = { ...bot.position };
    }

    this.updateHumanIntents();
    this.updateBotAi();
    // The shared kinematics module integrates movement (substepped against
    // walls) and applies capped shoulder-past separation.
    this.applyMovement(dtMs);
    this.resolveBotSeparation(dtMs);
    this.resolveStairs();
    this.recordPositionHistory();
    this.resolveMines(dtMs);
    this.resolveCombat();
    this.resolveDotCapture(dtMs);
    this.resolveDownedCoverage(dtMs);
    this.resolveExtraction(dtMs);
    this.resolveSwaps(dtMs);
  }

  getSnapshot(): GameSnapshot {
    const bots = [...this.bots.values()].map(toBotSnapshot);
    const dots = [...this.dots.values()].map((dot) => ({ ...dot, position: { ...dot.position } }));
    const mines = [...this.mines.values()].map((mine): MineEntity => ({
      id: mine.id,
      position: { ...mine.position },
      radius: mine.radius,
      placedByBotId: mine.placedByBotId,
      squadId: mine.squadId,
      floorId: mine.floorId,
      placedAtMs: mine.placedAtMs,
      revealedToBotIds: [...mine.revealMsByBotId.keys()],
    }));

    return {
      timeMs: this.timeMs,
      bots,
      dots,
      mines,
      coverages: [...this.coverages.values()].map((coverage) => ({ ...coverage })),
      noises: this.noises.map((noise) => ({ ...noise, position: { ...noise.position } })),
      doors: [...this.doors.values()].map(({ doorway: _doorway, holdRemainingMs: _hold, ...door }) => ({
        ...door,
        position: { ...door.position },
      })),
      debug: {
        tickHz: this.config.tickHz,
        tickCount: this.tickCount,
        fps: this.fps,
        activeBodies: bots.length,
        activeDots: dots.filter((dot) => dot.active).length,
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
  }

  // ---------------------------------------------------------------------------
  // Per-tick systems
  // ---------------------------------------------------------------------------

  private emitNoise(kind: NoiseKind, position: Vec2, floorId: string, loudness: number, source?: InternalBot): void {
    if (source && source.incognitoMs > 0) return;
    this.noises.push({
      id: `n${this.noiseSeq++}`,
      kind,
      position: { ...position },
      floorId,
      loudness,
      ageMs: 0,
      ttlMs: NOISE_TTL_MS,
    });
  }

  private ageNoises(dtMs: number): void {
    for (const noise of this.noises) {
      noise.ageMs += dtMs;
    }

    this.noises = this.noises.filter((noise) => noise.ageMs < noise.ttlMs);
  }

  private updateDoors(dtMs: number): void {
    for (const door of this.doors.values()) {
      const triggerRadius = door.doorway.triggerRadius ?? DEFAULT_DOOR_TRIGGER_RADIUS;
      const nearby = [...this.bots.values()].some((bot) =>
        bot.state === "alive" &&
        bot.floorId === door.floorId &&
        distance(bot.position, door.position) <= triggerRadius + bot.radius,
      );
      const durationMs = Math.max(1, door.doorway.openDurationMs ?? DEFAULT_DOOR_OPEN_MS);
      const delta = dtMs / durationMs;

      if (door.phase === "closed" && nearby) {
        door.phase = "opening";
        door.holdRemainingMs = door.doorway.holdOpenMs ?? DEFAULT_DOOR_HOLD_MS;
        this.emitNoise("door", door.position, door.floorId, door.doorway.noiseLoudness ?? DEFAULT_DOOR_NOISE);
      }

      if (door.phase === "opening") {
        door.openness = Math.min(1, door.openness + delta);
        if (door.openness >= 1) {
          door.phase = "open";
          door.holdRemainingMs = door.doorway.holdOpenMs ?? DEFAULT_DOOR_HOLD_MS;
        }
      } else if (door.phase === "open") {
        if (nearby) {
          door.holdRemainingMs = door.doorway.holdOpenMs ?? DEFAULT_DOOR_HOLD_MS;
        } else {
          door.holdRemainingMs = Math.max(0, door.holdRemainingMs - dtMs);
          if (door.holdRemainingMs === 0) door.phase = "closing";
        }
      } else if (door.phase === "closing") {
        if (nearby) {
          door.phase = "opening";
          door.holdRemainingMs = door.doorway.holdOpenMs ?? DEFAULT_DOOR_HOLD_MS;
        } else {
          door.openness = Math.max(0, door.openness - delta);
          if (door.openness <= 0) door.phase = "closed";
        }
      }

      door.blocking = door.openness < DOOR_BLOCKING_THRESHOLD;
    }
  }

  /**
   * Everything solid on a floor this tick, as `Solid`s: the map's static geometry
   * plus whichever authoritative doors are currently blocking.
   */
  private solidsForFloor(floorId: string): SolidSource {
    const physicsId = physicsFloorId(this.map, floorId);
    const doors = [...this.doors.values()]
      .filter((door) => door.floorId === physicsId && door.blocking)
      .map((door) => rectSolid(doorwayCollisionRect(door.doorway)));
    const index = this.solidIndexes.get(physicsId);
    if (!index) return [...(this.staticSolids.get(physicsId) ?? []), ...doors];
    // Doors stay after the static geometry, which is where they sat when the plane
    // was one flat array. Resolution is order-dependent, so that matters.
    return withExtraSolids(index, doors);
  }

  private doorOccludersForFloor(floorId: string): Rect[] {
    return [...this.doors.values()]
      .filter((door) => door.floorId === physicsFloorId(this.map, floorId) && door.blocking)
      .map(doorEntityCollisionRect);
  }

  /** True once per CHANNEL_PING_MS while a channel's progress accumulates. */
  private channelPingDue(progressMs: number, dtMs: number): boolean {
    return Math.floor(progressMs / CHANNEL_PING_MS) > Math.floor((progressMs - dtMs) / CHANNEL_PING_MS);
  }

  private updateTimers(dtMs: number): void {
    for (const bot of this.bots.values()) {
      bot.dashCooldownMs = Math.max(0, bot.dashCooldownMs - dtMs);
      bot.dashActiveMs = Math.max(0, bot.dashActiveMs - dtMs);
      bot.invulnerabilityMs = Math.max(0, bot.invulnerabilityMs - dtMs);
      bot.pleaCooldownMs = Math.max(0, bot.pleaCooldownMs - dtMs);
      bot.pingCooldownMs = Math.max(0, bot.pingCooldownMs - dtMs);
      bot.incognitoMs = Math.max(0, bot.incognitoMs - dtMs);
      const previousRadarMs = bot.radarActiveMs;
      bot.radarActiveMs = Math.max(0, bot.radarActiveMs - dtMs);
      bot.radarPings = bot.radarPings
        .map((ping) => ({ ...ping, ageMs: ping.ageMs + dtMs }))
        .filter((ping) => ping.ageMs < this.config.radarPingTtlMs);
      if (previousRadarMs > 0) {
        bot.radarPingElapsedMs += dtMs;
        while (bot.radarPingElapsedMs >= this.config.radarPingIntervalMs) {
          bot.radarPingElapsedMs -= this.config.radarPingIntervalMs;
          for (const target of this.bots.values()) {
            if (target.id !== bot.id && target.floorId === bot.floorId && distance(bot.position, target.position) <= this.config.radarRadius) {
              bot.radarPings.push({ ...target.position, ageMs: 0 });
            }
          }
        }
      }
      bot.aiRetargetMs = Math.max(0, bot.aiRetargetMs - dtMs);
      bot.aiRepathMs = Math.max(0, bot.aiRepathMs - dtMs);

      for (const [targetId, remainingMs] of bot.aiAvoidTargets) {
        const nextRemainingMs = remainingMs - dtMs;
        if (nextRemainingMs <= 0) {
          bot.aiAvoidTargets.delete(targetId);
        } else {
          bot.aiAvoidTargets.set(targetId, nextRemainingMs);
        }
      }
    }

    for (const mine of this.mines.values()) {
      for (const [botId, remainingMs] of mine.revealMsByBotId) {
        const next = remainingMs - dtMs;
        if (next <= 0) mine.revealMsByBotId.delete(botId);
        else mine.revealMsByBotId.set(botId, next);
      }
    }
  }

  private updateHumanIntents(): void {
    for (const bot of this.bots.values()) {
      const controller = this.controllers.get(bot.id);
      /**
       * Anyone on the floor who is not a player calls for help on their own, and keeps
       * calling.
       *
       * Ahead of the controller checks below on purpose. Without it the recruit rule is
       * dead in solo: being picked up by a rival is gated on having pleaded, only a
       * human could plea, and every rival in a solo run is an AI. `frozen` gets it too
       * — that flag means "does not move", and a downed body does not move anyway.
       *
       * A player still pleas deliberately, on the key, because for them it is a
       * decision with a cooldown and a button. For everyone else it is what a body on
       * the floor would obviously do, and the cooldown is what stops it being a siren.
       */
      if (controller !== "human" && bot.state === "downed" && !bot.isAmbient && bot.pleaCooldownMs <= 0) {
        this.pleaFor(bot);
      }
      if (controller === "frozen") {
        bot.desiredMove = zeroVec();
        continue;
      }
      if (controller !== "human") {
        continue;
      }

      if (bot.state !== "alive") {
        const input = this.inputs.get(bot.id);
        if (bot.state === "downed" && input?.plea && !bot.isAmbient && bot.pleaCooldownMs <= 0) {
          this.pleaFor(bot);
        }
        // A downed bot may still mark. Watching a rival walk past while you wait for a
        // pickup is exactly when telling your squad where they are matters most.
        if (input?.ping) this.pingFor(bot, input.ping.kind, input.ping.position);
        if (input?.dash || input?.useBay !== undefined || input?.swapBay || input?.plea || input?.ping) {
          this.inputs.set(bot.id, { move: zeroVec(), dash: false, plea: false });
        }
        continue;
      }

      const input = this.inputs.get(bot.id) ?? { move: zeroVec(), dash: false };
      bot.desiredMove = bot.activeSwap ? zeroVec() : input.move;

      if (length(input.move) > 0.05) {
        bot.lastAim = input.move;
      }

      if (input.useBay !== undefined && isSlot(bot.bays, input.useBay)) {
        this.fireBay(bot, input.useBay);
      }
      if (input.swapBay && !bot.activeSwap) {
        const { bayIndex, holdIndex } = input.swapBay;
        if (isSlot(bot.bays, bayIndex) && isSlot(bot.hold, holdIndex)) {
          bot.activeSwap = { bayIndex, holdIndex, progressMs: 0 };
          bot.desiredMove = zeroVec();
        }
      }

      if (input.take) {
        this.takeFromBody(bot, input.take);
      }

      if (input.dash && !bot.activeSwap) {
        const overcharged = bot.dashOverchargeCharges > 0;
        if ((overcharged || bot.dashCooldownMs <= 0) && bot.dashActiveMs <= 0) {
          bot.dashActiveMs = this.config.dashDurationMs;
          if (overcharged) bot.dashOverchargeCharges -= 1;
          else bot.dashCooldownMs = this.config.dashCooldownMs;
          this.recordDashStartContacts(bot);
          this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash, bot);
        }

        // A press is consumed on the tick it is considered, fired or not.
        // Pressing during cooldown must never bank a dash for later.
      }
      if (input.ping) this.pingFor(bot, input.ping.kind, input.ping.position);
      if (input.dash || input.useBay !== undefined || input.swapBay || input.take || input.plea || input.ping) {
        this.inputs.set(bot.id, {
          ...input, dash: false, useBay: undefined, swapBay: undefined, take: undefined, plea: false, ping: undefined,
        });
      }
    }
  }

  private fireBay(bot: InternalBot, bayIndex: BayIndex): void {
    const item = bot.bays[bayIndex];
    if (!item || item.kind === "blueprint") return;
    bot.bays[bayIndex] = null;
    if (item.kind === "mine") {
      this.placeMine(bot);
      return;
    }
    switch (item.type) {
      case "health":
        restoreShieldPlate(bot.shieldSegments);
        bot.shields = plateSum(bot.shieldSegments);
        break;
      case "radar":
        bot.radarActiveMs = this.config.radarDurationMs;
        bot.radarPingElapsedMs = 0;
        for (const mine of this.mines.values()) {
          if (mine.floorId === bot.floorId && distance(mine.position, bot.position) <= this.config.radarRadius) {
            mine.revealMsByBotId.set(bot.id, this.config.radarDurationMs);
          }
        }
        break;
      case "dashOvercharge":
        bot.dashOverchargeCharges += this.config.dashOverchargeUses;
        break;
      case "incognito":
        bot.incognitoMs = this.config.incognitoDurationMs;
        break;
    }
    this.emitNoise("channel", bot.position, bot.floorId, this.config.powerupNoiseLoudness, bot);
  }

  private placeMine(bot: InternalBot): void {
    const mine: InternalMine = {
      id: `mine-${bot.id}-${this.mineSeq++}`,
      position: { ...bot.position },
      radius: this.config.dotRadius,
      placedByBotId: bot.id,
      squadId: bot.squadId,
      floorId: bot.floorId,
      placedAtMs: this.timeMs,
      revealedToBotIds: [],
      sensorElapsedMs: 0,
      revealMsByBotId: new Map(),
    };
    this.mines.set(mine.id, mine);

    const owned = [...this.mines.values()]
      .filter((candidate) => candidate.placedByBotId === bot.id)
      .sort((left, right) => left.placedAtMs - right.placedAtMs || left.id.localeCompare(right.id));
    while (owned.length > this.config.maxActiveMines) {
      const oldest = owned.shift()!;
      this.mines.delete(oldest.id);
      this.events.push({ type: "mineRotated", botId: bot.id, mineId: oldest.id });
    }
  }

  private resolveMines(dtMs: number): void {
    for (const mine of [...this.mines.values()]) {
      const intruders = [...this.bots.values()]
        .filter((bot) => bot.state === "alive" && bot.squadId !== mine.squadId && bot.floorId === mine.floorId)
        .sort((left, right) => distance(left.position, mine.position) - distance(right.position, mine.position) || left.id.localeCompare(right.id));
      const trigger = intruders.find((bot) => distance(bot.position, mine.position) + mine.radius <= bot.radius - 2);
      if (trigger) {
        this.detonateMine(mine, trigger);
        continue;
      }

      const sensed = intruders.find((bot) => distance(bot.position, mine.position) <= this.config.mineSenseRadius);
      if (!sensed) {
        mine.sensorElapsedMs = 0;
        continue;
      }
      mine.sensorElapsedMs += dtMs;
      while (mine.sensorElapsedMs >= this.config.mineSensePingMs) {
        mine.sensorElapsedMs -= this.config.mineSensePingMs;
        this.events.push({
          type: "mineSensor",
          botId: mine.placedByBotId,
          squadId: mine.squadId,
          mineId: mine.id,
          position: { ...sensed.position },
          floorId: mine.floorId,
        });
      }
    }
  }

  private detonateMine(mine: InternalMine, target: InternalBot): void {
    this.mines.delete(mine.id);
    // A mine reads exactly like any other hit: the arc it goes off in takes it, or
    // it reaches the core. One rule, so a mine can never do what a dash cannot.
    const impactAngle = Math.atan2(mine.position.y - target.position.y, mine.position.x - target.position.x);
    const armourHit = applyArmourHit(target.facing, target.shieldSegments, impactAngle);
    target.shields = plateSum(target.shieldSegments);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    this.emitNoise("mineDetonation", mine.position, mine.floorId, NOISE_LOUDNESS.mineDetonation);

    if (armourHit.core) {
      this.putBotDown(target, mine.placedByBotId);
    }
  }

  /**
   * One way for a body to go down, because there were two and they disagreed.
   *
   * A mine cleared the plate array; a dash left it exactly as it was. Nothing in the
   * simulation reads a downed bot's plates — combat, separation and contact all skip
   * anything that is not alive, and `reviveBot` writes a fresh array of its own — so
   * the difference was invisible until the HUD, which renders `shieldSegments`
   * straight. Play reported it: "when I'm downed, the legend still shows that I have
   * one shield, despite the downed status."
   *
   * Clearing is the right answer of the two. Going down through a bare arc while
   * still holding good plating is exactly what the core rule is for — the closest
   * thing this game has to a headshot — but those plates stop existing the moment
   * you are on the floor, and a bank that still shows them is telling the player
   * they have protection they cannot use.
   */
  private putBotDown(target: InternalBot, byBotId: string): void {
    // A plea belongs to the down it was made in.
    target.pleaded = false;
    target.shieldSegments = platesForCount(target.maxShields, 0);
    target.shields = 0;
    target.state = "downed";
    target.dashActiveMs = 0;
    target.velocity = zeroVec();
    target.knockbackMs = 0;
    this.events.push({ type: "downed", botId: target.id, byBotId });
  }

  /**
   * How far the nearest human is. `Infinity` when nobody is watching at all.
   *
   * Computed once per tick rather than per bot: with 25 bots and one player that
   * is 25 distance checks instead of 625, and at the scale this is meant to
   * survive the difference is the whole point.
   */
  private humanPositions(): Vec2[] {
    const at: Vec2[] = [];
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive") continue;
      if (this.controllers.get(bot.id) === "human") at.push(bot.position);
    }
    return at;
  }

  /**
   * ONE bot may run A* per tick, and this decides which.
   *
   * The throttle spreads replans over about a second, but it does not stop them
   * landing together, and they start together: every bot begins at
   * `aiRepathMs = 0`, so tick one is a stampede, and `targetChanged` re-clusters
   * them afterwards whenever a squad chases the same quarry. Measured in the
   * browser, that produced a 50-100ms freeze roughly every two seconds — seven in
   * fifteen seconds, against a median frame of 8.3ms. The average was never the
   * problem. Four searches in one frame was.
   *
   * Deferring a replan is close to free: the bot keeps walking the path it
   * already has, which is at most one tick out of date. Deferring it for LONG is
   * not free, so the permit goes to whoever needs it most — a bot with no path at
   * all cannot move until it plans, so those come first, then the most overdue.
   * Ties break on id, because this runs inside the authoritative simulation and
   * two hosts must make the same choice.
   */
  private grantPlanningPermit(candidates: InternalBot[]): void {
    this.planPermit = null;
    let best: InternalBot | null = null;
    let bestRank = -Infinity;
    for (const bot of candidates) {
      // Overdue by how long, with a large bonus for having nothing to walk.
      const rank = (bot.aiPath.length === 0 ? 1e9 : 0) - bot.aiRepathMs;
      if (rank > bestRank || (rank === bestRank && best !== null && bot.id < best.id)) {
        best = bot;
        bestRank = rank;
      }
    }
    this.planPermit = best?.id ?? null;
  }

  private updateBotAi(): void {
    const humans = this.humanPositions();
    const active: InternalBot[] = [];
    for (const bot of this.bots.values()) {
      if (this.controllers.get(bot.id) !== "ai" || bot.state !== "alive") continue;

      let nearest = Infinity;
      for (const human of humans) {
        const away = distance(bot.position, human);
        if (away < nearest) nearest = away;
      }
      bot.aiAttention = nearest;
      active.push(bot);
    }
    this.grantPlanningPermit(active);

    for (const bot of active) {
      const objective = this.pickBotTarget(bot);
      if (this.noteAiStall(bot, objective)) {
        // Blacklisted this tick: the objective it has been leaning on is gone, so
        // re-decide rather than spend one more tick walking into the same body.
        const replacement = this.pickBotTarget(bot);
        const routed = this.routeAiTarget(bot, replacement);
        bot.desiredMove = this.steerBotAlongPath(bot, routed);
        if (length(bot.desiredMove) > 0.05) bot.lastAim = bot.desiredMove;
        this.tryAiDash(bot, replacement);
        continue;
      }
      const routedTarget = this.routeAiTarget(bot, objective);
      const desired = this.steerBotAlongPath(bot, routedTarget);
      bot.desiredMove = desired;

      if (length(desired) > 0.05) {
        bot.lastAim = desired;
      }

      this.tryAiDash(bot, objective);
    }
  }

  private sameArena(bot: InternalBot, floorId: string, position: Vec2): boolean {
    return contextKey(this.map, bot.floorId, bot.position) === contextKey(this.map, floorId, position);
  }

  /**
   * Whether one bot can perceive another at all: same arena, or through a doorway.
   *
   * Everything that used to ask `sameArena` asks this instead, and the change is
   * deliberately symmetric. The street and a building's ground floor are separate arenas
   * even though a door joins them, so standing just outside an exit was a free hold: the
   * camper knew where the door was and whoever came out had no warning and no recourse.
   * Now both of them see the same patch either side of the mouth, which turns a guaranteed
   * ambush into a mutual first sighting.
   *
   * It cuts both ways for the AI too — hunters will engage across a threshold now. That is
   * the point rather than a side effect: a rule that only helped the player leaving would
   * just move the unfairness.
   */
  private canPerceive(bot: InternalBot, floorId: string, position: Vec2): boolean {
    return (
      this.sameArena(bot, floorId, position) ||
      seesOutdoors(this.map, bot.floorId, bot.position, floorId, position)
    );
  }

  /**
   * Whether a bot can actually SEE a point: perception, and then walls.
   *
   * Two filters spelled this out identically — arena check, range check, then the same
   * five-argument `hasLineOfSight` call — which is two places for one sighting rule to
   * live, and the doorway change had to be made in both. Now it is one.
   *
   * A doorway sighting deliberately skips the wall test. It cannot be done: the two
   * positions are in different contexts, so there is no single occluder list to cast the
   * ray against, and casting it in the viewer's own context means casting it at the
   * building footprint — which is opaque, so the answer would always be no. The proximity
   * rule in `seesThroughDoorway` is doing the occlusion work instead, by only ever
   * granting sight within a bot-length or so of the gap itself.
   */
  private canSee(bot: InternalBot, floorId: string, position: Vec2): boolean {
    const occluders = this.doorOccludersForFloor(bot.floorId);
    if (this.sameArena(bot, floorId, position)) {
      return hasLineOfSight(
        this.map,
        contextKey(this.map, bot.floorId, bot.position),
        bot.position,
        position,
        occluders,
      );
    }
    // Different arenas: the only join is a hole in a wall, so ask the merged geometry.
    return seesOutdoors(this.map, bot.floorId, bot.position, floorId, position, occluders);
  }

  /**
   * A bot that asks to move and goes nowhere eventually stops asking.
   *
   * Nothing in the AI knows another bot exists: the navigator plans on static
   * geometry only, and steering is a raw vector at the goal with no repulsion term.
   * So N bots after one objective are commanded at one identical point every tick
   * and separation is the only thing that knows two bodies cannot share space.
   * Measured in a corner: three bots asking for 27, 178 and 400 units of travel and
   * receiving exactly 0.0000, for 299 consecutive ticks, while the solver held every
   * pair correctly at its own rest distance. Not a physics failure — the same
   * scenario freezes identically with plain circular bodies and a LARGER unmet
   * demand. A legitimate traffic jam that nobody was willing to leave.
   *
   * So leave it. Ask for movement for a second and a half, get less than a quarter
   * of a body, and the objective goes on the bot's own avoid list — the same list an
   * unreachable objective already uses. It picks something else, walks away, and the
   * jam drains from the back. Per-bot and time-limited, so a jam of five clears as
   * five separate decisions rather than one stampede.
   *
   * Returns true if the objective was just dropped, so the caller re-decides
   * instead of spending this tick walking into the same body.
   */
  private noteAiStall(bot: InternalBot, objective: AiTarget): boolean {
    /**
     * Two ways to be stuck, and the second one is the quieter of the two.
     *
     * The obvious one is asking to travel and not travelling — a body in the way.
     * The other is a bot that has somewhere to be and asks for NOTHING, which is
     * what `steerToward` returns whenever it thinks it has arrived. Measured on the
     * real map: a bot on the clinic's first floor hunting a player 595 units away
     * across a floor boundary, producing exactly zero thrust, indefinitely, because
     * the last waypoint its own floor could offer was already inside the stop
     * distance for a target on the other side of it. `path.length === 0` has a
     * fallback; a path that ends short does not, and it looked identical from the
     * outside: a bot standing in a room doing nothing.
     *
     * So the test is arrival, not thrust. Either the bot is where it meant to be, or
     * it is going somewhere. Standing still short of your own objective is the
     * failure, however the AI arrived at it.
     */
    const arrived = distance(bot.position, objective.position) <= objective.stopDistance + AI_STALL_PROGRESS_PX;
    const travelling = length(bot.desiredMove) > AI_STALL_REQUEST
      && distance(bot.position, bot.aiStallFrom) > AI_STALL_PROGRESS_PX;
    // A channel is a deliberate stand-still, not a stall.
    const channelling = this.controllers.get(bot.id) === "frozen" || bot.activeSwap !== undefined;
    if (arrived || travelling || channelling) {
      bot.aiStallTicks = 0;
      bot.aiStallFrom = { ...bot.position };
      return false;
    }
    bot.aiStallTicks += 1;
    if (bot.aiStallTicks < AI_STALL_TICKS) {
      return false;
    }
    bot.aiStallTicks = 0;
    bot.aiStallFrom = { ...bot.position };
    bot.aiPath = [];
    if (objective.targetId === undefined) {
      // Wander has no target to avoid; the destination itself is the problem.
      bot.aiWanderTarget = this.pickWanderTarget(bot);
      return true;
    }
    bot.aiAvoidTargets.set(objective.targetId, AI_STALL_AVOID_MS + this.nextRandom() * AI_STALL_AVOID_MS);
    return true;
  }

  /**
   * Where to stand while hunting: a slot on a ring around the target, not its centre.
   *
   * There is no bot-vs-bot avoidance anywhere in this game. The navigator plans on
   * static geometry only — no bot position ever enters it — and `steerToward` is a
   * raw vector at the goal with no repulsion term. So N hunters locked on one target
   * were all commanded at the *same world point* every tick, and the separation pass
   * was the only thing on the whole tick that knew two bodies cannot share space.
   * That is the pile-up play kept reporting.
   *
   * A slot fixes it at the source: each hunter is sent somewhere different. The
   * assignment has to be a pure function of the snapshot, or two bots reach different
   * conclusions and swap slots every tick — so a hunter's slot is its RANK BY ID
   * among everyone hunting the same target, which every bot computes identically from
   * state alone with nothing written down.
   *
   * The ring breathes with the target's plate state, because `contactGap` does: a
   * hunter stands at 50 off a fully plated bot and 35.6 off a bare core, so a swarm
   * visibly closes in on a damaged side. What must NOT breathe is the spacing between
   * hunters — that is a queueing distance, not a contact one — so the ring is widened
   * whenever the slots would otherwise sit closer together than two full bodies.
   */
  private huntTarget(bot: InternalBot, target: InternalBot): AiTarget {
    const standOff = this.huntStopDistance(bot, target);
    const claimants = this.huntClaimants(target);
    const index = claimants.indexOf(bot.id);
    const slots = claimants.length;
    /**
     * A lone hunter walks straight at its target, exactly as before.
     *
     * Slotting it too was the first version, and it turned every duel into an orbit:
     * the bot was sent to a fixed bearing off the target rather than at it, so a
     * player walking in was chased by a bot sidestepping to keep its assigned angle.
     * Measured, it settled 92 units away instead of coming to rest on contact at
     * 35.6. A slot exists to keep hunters off each other, so with nobody to avoid
     * there is nothing for it to do.
     */
    if (slots < 2 || index < 0) {
      return makeAiTarget(target.position, target.floorId, standOff, bot.radius * 4.5, "hunt", target.id);
    }
    /**
     * Chord between adjacent slots is `2 * r * sin(pi / slots)`, so the radius that
     * keeps them a body apart is `SLOT_CHORD / (2 * sin(pi / slots))`. At four
     * hunters the contact ring is already wide enough; past six it is not, and
     * without this they would be assigned slots inside each other.
     */
    const spread = slots > 1 ? SLOT_CHORD / (2 * Math.sin(Math.PI / slots)) : 0;
    const ring = Math.max(standOff, spread);
    // Anchored to the target's own identity rather than to its facing, or the whole
    // ring would spin every time it turned and drag every hunter around with it.
    const base = (stableHash(target.id) % 360) * (Math.PI / 180);
    const bearing = base + (this.slotFor(bot, target, claimants) * Math.PI * 2) / slots;
    const slot = {
      x: target.position.x + Math.cos(bearing) * ring,
      y: target.position.y + Math.sin(bearing) * ring,
    };
    /**
     * A slot is a preference, not a demand. Inside a building, or against a target
     * backed into a corner, most of the ring is wall — so a slot the navigator cannot
     * reach falls back to the old behaviour of walking at the target, which is worse
     * for crowding and still correct.
     */
    const reachable = findNavigationPath(this.map, bot.floorId, bot.position, slot, bot.radius).length > 0;
    return reachable
      ? makeAiTarget(slot, target.floorId, AI_SLOT_ARRIVAL, bot.radius * 4.5, "hunt", target.id)
      : makeAiTarget(target.position, target.floorId, standOff, bot.radius * 4.5, "hunt", target.id);
  }

  /**
   * Which slot on the ring is this bot's.
   *
   * Rank by id was the first answer and it was measurably worse than it looks: it
   * hands out bearings with no regard for where anybody already is, so hunters cross
   * the ring — and each other — to reach an arbitrary angle. Measured over 900 ticks
   * with five hunters, that doubled the ticks with any pair in contact, 11.4% to
   * 25.2%, purely in shallow traffic on the way to a slot.
   *
   * So slots go to whoever is already nearest them: claimants in id order each take
   * the closest unclaimed bearing. Greedy rather than optimal, which is fine — the
   * property that matters is that every bot is somewhere different, not that the
   * assignment minimises total travel. Id order keeps it deterministic, so the server
   * and any observer derive the same answer from the same snapshot.
   */
  private slotFor(bot: InternalBot, target: InternalBot, claimants: string[]): number {
    const slots = claimants.length;
    const base = (stableHash(target.id) % 360) * (Math.PI / 180);
    const taken = new Array<boolean>(slots).fill(false);
    let mine = 0;
    for (const id of claimants) {
      const claimant = this.bots.get(id);
      const bearing = claimant
        ? Math.atan2(claimant.position.y - target.position.y, claimant.position.x - target.position.x)
        : base;
      let best = -1;
      let bestOff = Infinity;
      for (let slot = 0; slot < slots; slot += 1) {
        if (taken[slot]) continue;
        const off = Math.abs(normalizeAngle(bearing - (base + (slot * Math.PI * 2) / slots)));
        if (off < bestOff) {
          bestOff = off;
          best = slot;
        }
      }
      if (best < 0) best = 0;
      taken[best] = true;
      if (id === bot.id) mine = best;
    }
    return mine;
  }

  /**
   * Everyone with a claim on this target, by id, so slot ranks agree everywhere.
   *
   * Derived from hostility and proximity rather than from anybody's current
   * objective, which would be circular: the objective is what the slot is being
   * chosen for.
   */
  private huntClaimants(target: InternalBot): string[] {
    const claimants: string[] = [];
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive" || bot.id === target.id) continue;
      if (this.controllers.get(bot.id) !== "ai") continue;
      if (bot.floorId !== target.floorId || areFriendly(bot, target)) continue;
      if (distance(bot.position, target.position) > AI_SLOT_CLAIM_RANGE) continue;
      claimants.push(bot.id);
    }
    return claimants.sort((left, right) => left.localeCompare(right));
  }

  /**
   * Whether another bot has a better claim on this body than `bot` does.
   *
   * A downed body is a channel, and a channel is for one bot. Sending the whole
   * squad meant they pressed inward on a ring none of them could share: measured
   * over 1800 ticks, two bots settled 24.0 units from the body still commanded at
   * 37.8 px/s, three at 27.9 and 48.5 px/s, four at 33.9 and 64.8 — never settling,
   * because four plated bodies need 33.94 units of spacing around a corpse and the
   * range that lets you channel it tops out at 37.2. Six cannot be seated at any
   * distance at all.
   *
   * Nearest wins, id breaks a tie, so every bot in the squad reaches the same
   * conclusion from the same snapshot without anybody writing a claim down. The
   * losers fall through to the next objective in their own list, which is what they
   * should have been doing.
   */
  /**
   * Ask to be picked up. One path, so a human's plea and an AI's are the same event.
   *
   * `pleaded` is standing consent rather than a momentary one: having asked once, a
   * rival may carry you until you are back on your feet or back on the floor. A
   * one-tick flag would mean the recruit had to land inside the same tick as the
   * shout, which is not a thing a player can aim at.
   */
  /**
   * Mark a place for your squad.
   *
   * AN EVENT AND NOTHING ELSE — no simulation state, no snapshot field, no entity list.
   * That is the design decision worth recording, because the obvious build is a `pings`
   * array on the world with a TTL and a per-squad cap, and it is more machinery than a
   * mark deserves. A ping carries no authority: it cannot be shot, cannot be walked into,
   * decides nothing, and expires. Everything it needs is in the one event that announces
   * it, so the client holds it for a few seconds and forgets it.
   *
   * The cost is honest and small: a player who reconnects mid-run does not inherit marks
   * placed while they were away. For something whose whole value is "look here NOW", a
   * stale mark restored on reconnect would be worse than a missing one.
   *
   * Rate limited per bot, which is also the spam control. There is no per-squad cap because
   * without stored state there is nothing to cap — four players each limited to one mark
   * every `pingCooldownMs` cannot paper the map faster than the marks expire.
   *
   * The position is clamped to the sheet but deliberately NOT checked against line of
   * sight. Marking somewhere you cannot see is the point: round a corner, up a floor, where
   * they were last seen.
   */
  private pingFor(bot: InternalBot, kind: PingKind, position: Vec2): void {
    if (bot.pingCooldownMs > 0) return;
    bot.pingCooldownMs = this.config.pingCooldownMs;
    /**
     * A mark makes a sound, which is a deliberate cost rather than only feedback.
     *
     * The squad needs to know one arrived without staring at the map, and the ring is how
     * every other event in this game announces itself. It is quiet — a mark is a voice, not
     * a dash — but it is audible, so pinging is not free: spam it beside a rival and you
     * have told them where you are.
     */
    this.emitNoise("ping", bot.position, bot.floorId, NOISE_LOUDNESS.ping, bot);
    const at = {
      x: clamp(position.x, 0, this.map.width),
      y: clamp(position.y, 0, this.map.height),
    };
    /**
     * Held for the AI, and this REVERSES the event-only design that was here an hour ago.
     *
     * That design was right for the renderer and wrong for the squad: an AI squadmate has to
     * still be acting on a mark seconds after it lands, while it walks there, so something
     * has to remember it. Reacting only in the tick the event fires would mean the marks did
     * nothing for exactly the squadmates they were asked to command.
     *
     * The half of the decision that survives is the one that mattered: this does NOT go on
     * the snapshot. A mark has no authority — nothing collides with it, nothing shoots it —
     * so the authoritative world stays clean and the client still builds its own marks from
     * events. This list is AI memory, not world state.
     */
    this.squadMarks = this.squadMarks
      .filter((mark) => mark.squadId !== bot.squadId || this.timeMs - mark.atMs < PING_MEMORY_MS)
      .filter((mark) => !(mark.squadId === bot.squadId && mark.kind === kind))
      .concat({ squadId: bot.squadId, kind, position: at, floorId: bot.floorId, atMs: this.timeMs });
    this.events.push({
      type: "pinged",
      botId: bot.id,
      squadId: bot.squadId,
      pingId: `ping-${bot.id}-${Math.round(this.timeMs)}`,
      kind,
      position: { ...at },
      floorId: bot.floorId,
    });
  }

  /**
   * The freshest live mark of a kind for this bot's squad, on a floor it can act on.
   *
   * One per kind per squad, newest replacing older, because an AI cannot chase two "enemy"
   * marks and choosing between them is not a decision worth modelling — the newest is the
   * one carrying current information. Same reasoning as the client's cap, arrived at from
   * the other end.
   */
  private markFor(bot: InternalBot, kind: PingKind): { position: Vec2; floorId: string } | null {
    const mark = this.squadMarks.find(
      (candidate) => candidate.squadId === bot.squadId
        && candidate.kind === kind
        && this.timeMs - candidate.atMs < PING_MEMORY_MS,
    );
    return mark ? { position: mark.position, floorId: mark.floorId } : null;
  }

  /**
   * Bias an AI squadmate's objective toward what its squad has marked.
   *
   * A NUDGE, not an order, and the distinction is the whole design. A mark that overrode the
   * AI outright would let one click walk a squadmate off a roof or out of a fight it was
   * winning, and a player cannot see enough of the AI's situation to be given that power. So
   * a mark bends what the bot was already choosing between:
   *
   *  - `enemy` promotes a rival NEAR THE MARK, so pointing at nothing does nothing
   *  - `loot`  promotes an uncollected Dot near the mark, same condition
   *  - `here`  is the universal one: go there, and take whatever is worth taking on arrival
   *
   * `here` deliberately has no "is there something there" test, because that is what makes
   * it universal — it is the mark you use when you cannot say why, and the bot working out
   * what is nearby when it arrives is exactly the behaviour asked for.
   */
  private markedObjective(bot: InternalBot): AiTarget | null {
    const enemyMark = this.markFor(bot, "enemy");
    if (enemyMark) {
      const rival = [...this.bots.values()]
        .filter((target) => target.state === "alive" && !areFriendly(bot, target))
        .filter((target) => distance(target.position, enemyMark.position) < PING_PULL)
        .sort((a, b) => distance(a.position, enemyMark.position) - distance(b.position, enemyMark.position))[0];
      if (rival) return this.huntTarget(bot, rival);
    }

    const lootMark = this.markFor(bot, "loot");
    if (lootMark) {
      const dot = [...this.dots.values()]
        .filter((candidate) => candidate.active)
        .filter((candidate) => distance(candidate.position, lootMark.position) < PING_PULL)
        .sort((a, b) => distance(a.position, lootMark.position) - distance(b.position, lootMark.position))[0];
      if (dot) {
        return makeAiTarget(dot.position, dot.floorId, this.config.botRadius * 0.5, this.config.botRadius * 2, "loot", dot.id);
      }
    }

    const here = this.markFor(bot, "here");
    if (here && distance(bot.position, here.position) > PING_ARRIVED) {
      return makeAiTarget(here.position, here.floorId, PING_ARRIVED, PING_ARRIVED * 1.6, "investigate");
    }
    return null;
  }

  private pleaFor(bot: InternalBot): void {
    bot.pleaCooldownMs = this.config.pleaCooldownMs;
    bot.pleaded = true;
    this.events.push({ type: "plea", botId: bot.id, squadId: bot.squadId, position: { ...bot.position }, floorId: bot.floorId });
  }

  /** `canReviveBody` against this simulation's live squad sizes. */
  private canRecruit(actor: InternalBot, body: InternalBot): boolean {
    return canReviveBody(actor, body, this.squadSize(actor.squadId), this.config.maxSquadSize);
  }

  /** How many bodies belong to this squad, standing or down. */
  private squadSize(squadId: string): number {
    let count = 0;
    for (const bot of this.bots.values()) {
      // A downed squadmate still counts: they are coming back, and the slot is theirs.
      if (bot.squadId === squadId) count += 1;
    }
    return count;
  }

  private outclaimed(bot: InternalBot, body: InternalBot): boolean {
    const mine = distance(bot.position, body.position);
    for (const other of this.bots.values()) {
      if (other.id === bot.id || other.state !== "alive") continue;
      if (this.controllers.get(other.id) !== "ai") continue;
      if (other.floorId !== bot.floorId) continue;
      if (other.aiAvoidTargets.has(body.id)) continue;
      if (areFriendly(bot, body) !== areFriendly(other, body)) continue;
      const theirs = distance(other.position, body.position);
      if (theirs < mine || (theirs === mine && other.id < bot.id)) return true;
    }
    return false;
  }

  private pickBotTarget(bot: InternalBot): AiTarget {
    if (bot.isAmbient) return this.pickAmbientTarget(bot);
    // A squad's marks steer its own AI members. Ambient greys are nobody's squadmates and
    // ignore them, which is also what keeps a mark from herding the whole map.
    const marked = this.markedObjective(bot);
    if (marked) return marked;
    const sameBuilding = (target: { floorId: string; position: Vec2 }) => {
      const botPlan = resolvePlan(this.map, bot.floorId, bot.position);
      const targetPlan = resolvePlan(this.map, target.floorId, target.position);
      return botPlan !== null && targetPlan !== null && botPlan.buildingId === targetPlan.buildingId;
    };
    const localOrVertical = (target: { floorId: string; position: Vec2 }) => this.canPerceive(bot, target.floorId, target.position) || sameBuilding(target);
    const available = (target: { id: string }) => !bot.aiAvoidTargets.has(target.id);
    const rank = <T extends { floorId: string; position: Vec2 }>(values: T[]) =>
      values.sort((a, b) => this.strategicDistance(bot, a) - this.strategicDistance(bot, b))[0];

    const friendlyDowned = rank(
      [...this.bots.values()].filter(
        (target) => target.id !== bot.id && target.state === "downed" && areFriendly(bot, target) && localOrVertical(target) && available(target)
          && !this.outclaimed(bot, target),
      ),
    );

    if (friendlyDowned && this.strategicDistance(bot, friendlyDowned) < 760) {
      return makeAiTarget(friendlyDowned.position, friendlyDowned.floorId, bot.radius * BODY_CHANNEL_STAND_OFF, bot.radius * 3, "revive", friendlyDowned.id);
    }

    const shouldFlee = carriedCount(bot) > 0 && bot.shields <= 1;
    const inventoryFull = carriedCount(bot) >= this.config.baySlots + this.config.holdSlots;

    if (!bot.isAmbient && (shouldFlee || inventoryFull)) {
      const extraction = this.nearestExtractionTarget(bot);
      if (extraction) {
        return extraction;
      }
    }

    const hostileDowned = rank(
      [...this.bots.values()].filter(
        (target) => target.id !== bot.id && target.state === "downed" && !areFriendly(bot, target) && localOrVertical(target) && available(target)
          && !this.outclaimed(bot, target),
      ),
    );

    if (hostileDowned && this.strategicDistance(bot, hostileDowned) < 760) {
      return makeAiTarget(hostileDowned.position, hostileDowned.floorId, bot.radius * BODY_CHANNEL_STAND_OFF, bot.radius * 3, "strip", hostileDowned.id);
    }

    const visibleHostile = rank(
      [...this.bots.values()].filter(
        (target) =>
          target.id !== bot.id &&
          target.state === "alive" &&
          !areFriendly(bot, target) &&
          available(target) &&
          distance(bot.position, target.position) < 540 &&
          this.canSee(bot, target.floorId, target.position),
      ),
    );

    if (visibleHostile) {
      return this.huntTarget(bot, visibleHostile);
    }

    const dot = rank(
      [...this.dots.values()].filter(
        (candidate) => candidate.active && carriedCount(bot) < this.config.baySlots + this.config.holdSlots && localOrVertical(candidate) && available(candidate),
      ),
    );

    if (dot && this.strategicDistance(bot, dot) < 820) {
      // Stop just inside the same visible-overlap boundary used for players,
      // rather than driving the AI core all the way over the Dot.
      return makeAiTarget(dot.position, dot.floorId, Math.max(2, interactionDotReach(bot.radius, dot.radius) - 2), bot.radius * 3.2, "loot", dot.id);
    }

    if (!bot.isAmbient && carriedCount(bot) >= Math.max(2, this.config.baySlots + this.config.holdSlots - 2)) {
      const extraction = this.nearestExtractionTarget(bot);
      if (extraction) {
        return extraction;
      }
    }

    const strategicHostile = rank(
      [...this.bots.values()].filter(
        (target) => target.id !== bot.id && target.state === "alive" && !areFriendly(bot, target) && localOrVertical(target) && available(target),
      ),
    );

    if (strategicHostile && this.strategicDistance(bot, strategicHostile) < 900) {
      return this.huntTarget(bot, strategicHostile);
    }

    const heard = [...this.noises]
      .reverse()
      .find(
        (noise) =>
          available(noise) && classifyNoise(this.map, bot.floorId, bot.position, noise.floorId, noise.position, noise.loudness) !== null,
      );

    if (heard) {
      return makeAiTarget(heard.position, heard.floorId, 34, bot.radius * 5, "investigate", heard.id);
    }

    // Idle AI squadmates keep the first living human controller in view,
    // including climbing after them.
    const squadHuman = [...this.bots.values()]
      .filter(
        (target) =>
          target.squadId === bot.squadId &&
          target.state === "alive" &&
          this.controllers.get(target.id) === "human",
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];

    if (squadHuman && available(squadHuman)) {
      return makeAiTarget(squadHuman.position, squadHuman.floorId, bot.radius * 3, bot.radius * 7, "escort", squadHuman.id);
    }

    if (bot.aiRetargetMs <= 0 || distance(bot.position, bot.aiWanderTarget) < 48) {
      bot.aiWanderTarget = this.pickWanderTarget(bot);
      bot.aiRetargetMs = 1400 + this.nextRandom() * 1500;
    }

    return makeAiTarget(bot.aiWanderTarget, bot.floorId, 48, bot.radius * 4, "wander");
  }

  private pickAmbientTarget(bot: InternalBot): AiTarget {
    const available = (target: { id: string }) => !bot.aiAvoidTargets.has(target.id);
    const hostile = [...this.bots.values()]
      .filter((target) =>
        target.id !== bot.id && target.state === "alive" && !areFriendly(bot, target) && available(target) &&
        distance(bot.position, target.position) < 540 &&
        this.canSee(bot, target.floorId, target.position))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];
    if (hostile) {
      return this.huntTarget(bot, hostile);
    }

    const heard = [...this.noises].reverse().find((noise) =>
      available(noise) && classifyNoise(this.map, bot.floorId, bot.position, noise.floorId, noise.position, noise.loudness) !== null);
    if (heard) return makeAiTarget(heard.position, heard.floorId, 34, bot.radius * 5, "investigate", heard.id);

    const strategic = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "alive" && !areFriendly(bot, target) && available(target))
      .sort((a, b) => this.strategicDistance(bot, a) - this.strategicDistance(bot, b))[0];
    if (strategic && this.strategicDistance(bot, strategic) < 900) {
      return this.huntTarget(bot, strategic);
    }

    if (bot.aiRetargetMs <= 0 || distance(bot.position, bot.aiWanderTarget) < 48) {
      bot.aiWanderTarget = this.pickWanderTarget(bot);
      bot.aiRetargetMs = 1400 + this.nextRandom() * 1500;
    }
    return makeAiTarget(bot.aiWanderTarget, bot.floorId, 48, bot.radius * 4, "wander");
  }

  private strategicDistance(bot: InternalBot, target: { floorId: string; position: Vec2 }): number {
    const botPlan = resolvePlan(this.map, bot.floorId, bot.position);
    const targetPlan = resolvePlan(this.map, target.floorId, target.position);
    let score = distance(bot.position, target.position);

    if (botPlan && targetPlan) {
      if (botPlan.buildingId === targetPlan.buildingId) {
        const building = this.map.buildings.find((candidate) => candidate.id === botPlan.buildingId);
        const botIndex = building?.floors.findIndex((floor) => floor.id === botPlan.planId) ?? -1;
        const targetIndex = building?.floors.findIndex((floor) => floor.id === targetPlan.planId) ?? -1;
        const botLevel = botIndex >= 0 ? botIndex : floorHeight(botPlan.label);
        const targetLevel = targetIndex >= 0 ? targetIndex : floorHeight(targetPlan.label);
        score += Math.abs(botLevel - targetLevel) * 150;
      } else {
        score += Math.abs(floorHeight(botPlan.label) - floorHeight(targetPlan.label)) * 150;
        score += 420;
      }
    } else if (botPlan || targetPlan) {
      score += 180;
    }

    return score;
  }

  private nearestExtractionTarget(bot: InternalBot): AiTarget | null {
    const point = this.map.extractionPoints
      .filter((candidate) => !bot.aiAvoidTargets.has(candidate.id))
      .sort((a, b) => {
        const aCenter = { x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2 };
        const bCenter = { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 };
        return distance(bot.position, aCenter) - distance(bot.position, bCenter);
      })[0];

    if (!point) {
      return null;
    }

    return makeAiTarget(
      { x: point.rect.x + point.rect.w / 2, y: point.rect.y + point.rect.h / 2 },
      OUTDOOR_FLOOR_ID,
      12,
      bot.radius * 5,
      "extract",
      point.id,
    );
  }

  /** Convert a strategic target into the next same-floor navigation target. */
  private routeAiTarget(bot: InternalBot, target: AiTarget): AiTarget {
    const targetFloorId = physicsFloorId(this.map, target.floorId);

    if (bot.floorId === targetFloorId) {
      return { ...target, floorId: bot.floorId };
    }

    const currentPlan = resolvePlan(this.map, bot.floorId, bot.position);
    const finalPlan = resolvePlan(this.map, targetFloorId, target.position);

    if (currentPlan) {
      const currentBuilding = this.map.buildings.find((building) => building.id === currentPlan.buildingId);
      const ground = currentBuilding?.floors.find(isGroundFloor);
      const destinationPlanId = finalPlan?.buildingId === currentPlan.buildingId ? finalPlan.planId : ground?.id;

      if (destinationPlanId && destinationPlanId !== currentPlan.planId) {
        const nextPlanId = this.nextPlanOnRoute(currentPlan.planId, destinationPlanId);
        const plan = floorPlanById(this.map, currentPlan.planId);
        const stair = nextPlanId
          ? plan?.stairs.find((candidate) => this.stairTargetPlanId(currentBuilding!, candidate) === nextPlanId)
          : undefined;

        if (stair) {
          return {
            ...target,
            floorId: bot.floorId,
            position: stairExitPoint(stair),
            stopDistance: 1,
            slowDistance: bot.radius * 4,
            projectionAllowed: false,
          };
        }
      }
    }

    // From the street, enter the target building through a real ground door.
    if (!currentPlan && finalPlan) {
      const building = this.map.buildings.find((candidate) => candidate.id === finalPlan.buildingId);
      if (building) {
        return {
          ...target,
          floorId: OUTDOOR_FLOOR_ID,
          position: this.nearestBuildingEntrance(building, bot.position),
          stopDistance: 8,
          slowDistance: bot.radius * 4,
          projectionAllowed: false,
        };
      }
    }

    return { ...target, floorId: bot.floorId };
  }

  private nextPlanOnRoute(start: string, goal: string): string | null {
    const connections = stairConnections(this.map);
    const queue = [start];
    const previous = new Map<string, string | null>([[start, null]]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === goal) {
        break;
      }

      for (const next of connections.get(current) ?? []) {
        if (!previous.has(next)) {
          previous.set(next, current);
          queue.push(next);
        }
      }
    }

    if (!previous.has(goal)) {
      return null;
    }

    let cursor = goal;
    while (previous.get(cursor) && previous.get(cursor) !== start) {
      cursor = previous.get(cursor)!;
    }
    return cursor === start ? null : cursor;
  }

  private stairTargetPlanId(building: Building, stair: StairLink): string | null {
    if (stair.toFloorId !== OUTDOOR_FLOOR_ID) {
      return stair.toFloorId;
    }
    return building.floors.find(isGroundFloor)?.id ?? null;
  }

  private nearestBuildingEntrance(building: Building, from: Vec2): Vec2 {
    const ground = building.floors.find(isGroundFloor);
    const fp = building.footprint;
    const inset = this.config.botRadius + 18;
    const candidates = (ground?.doorways ?? []).flatMap((doorway) => {
      if (doorway.dir === "h" && Math.abs(doorway.y - (fp.y + 6)) < 10) {
        return [{ x: doorway.x, y: fp.y + inset }];
      }
      if (doorway.dir === "h" && Math.abs(doorway.y - (fp.y + fp.h - 6)) < 10) {
        return [{ x: doorway.x, y: fp.y + fp.h - inset }];
      }
      if (doorway.dir === "v" && Math.abs(doorway.x - (fp.x + 6)) < 10) {
        return [{ x: fp.x + inset, y: doorway.y }];
      }
      if (doorway.dir === "v" && Math.abs(doorway.x - (fp.x + fp.w - 6)) < 10) {
        return [{ x: fp.x + fp.w - inset, y: doorway.y }];
      }
      return [];
    });

    return candidates.sort((a, b) => distance(from, a) - distance(from, b))[0] ?? {
      x: fp.x + fp.w / 2,
      y: fp.y + fp.h / 2,
    };
  }

  /**
   * How often this bot is worth replanning, and how far its target must move to
   * force one early.
   *
   * A MAP'S AREA IS FREE. Measured, because the opposite is the intuitive guess:
   * the identical 300-unit walk costs 0.05ms on downtown's 2400x1600 sheet and
   * 0.08ms on The Reach's 4200x3400 one, and the identical 900-unit walk costs
   * 1.10ms and 0.88ms. Tripling the sheet costs nothing. `prepareGrid` is paid
   * once at load, and A* explores outward from the start, not over the sheet.
   *
   * What is not free is JOURNEY LENGTH, and it is worse than linear because the
   * frontier grows in two dimensions:
   *
   *     300u  0.08ms      1534u   2.64ms  (downtown -> yard)
   *     900u  0.88ms      1869u  23.27ms  (yard -> temple, through the maze)
   *
   * Downtown was too small to contain a long journey. The Reach is not, so bots
   * started asking for routes across four regions — at 1.63 replans a tick that
   * was 15.3ms of a 16.7ms budget, the entire frame, spent planning walks no
   * player was there to watch.
   *
   * So planning effort is spent where it can be seen. A bot near a human keeps
   * the original cadence exactly; a bot on the far side of the world plans on a
   * long timer with a loose target threshold. It still walks, still hunts, still
   * follows the path it has — it just is not re-deriving a world-crossing route
   * every second for an empty room. Nothing a player can observe changes, which
   * is what makes this safe rather than a difficulty cut.
   *
   * Worth 20.9ms -> 11.6ms a tick on The Reach. That is a demand fix, and it is
   * half the answer: the cost of one long search is untouched, so what is left is
   * the bots near the player planning genuinely long routes. Because area is free
   * and only length is dear, the fix that lifts the size ceiling for good is to
   * make sure no single search is ever long — a coarse region-to-region route
   * over a portal graph, then local A* to the next portal only. Then cost stops
   * depending on distance as well as on area, and the map can be any size.
   *
   * What must NOT happen is widening the throttle for everyone: that trades a
   * stutter for hunters that cannot follow.
   */
  private replanInterval(bot: InternalBot): { hold: number; slack: number } {
    // A screen and a half: comfortably past anything a player can see or shoot.
    const NEAR = 900;
    if (bot.aiAttention <= NEAR) return { hold: 700 + this.nextRandom() * 300, slack: 1 };
    // Beyond that, ramp to 6x by the time a bot is a full sheet away. Continuous
    // on purpose: a step would make bots visibly change behaviour at a line.
    const ramp = Math.min(1, (bot.aiAttention - NEAR) / 2400);
    const scale = 1 + ramp * 5;
    return { hold: (700 + this.nextRandom() * 300) * scale, slack: scale };
  }

  private steerBotAlongPath(bot: InternalBot, target: AiTarget): Vec2 {
    const { hold, slack } = this.replanInterval(bot);
    const reach = (target.intent === "hunt" || target.intent === "escort" ? 64 : 20) * slack;
    const targetChanged = bot.aiPathFloorId !== bot.floorId || distance(bot.aiPathTarget, target.position) > reach;

    if ((bot.aiRepathMs <= 0 || targetChanged) && this.planPermit !== bot.id) {
      /**
       * Wants to plan, is not this tick's permit holder. Walking a path that is
       * one tick stale is invisible; steering with no path at all is not, because
       * the fallback below aims straight at the target and would cut through
       * geometry. So a bot with nothing to walk waits instead, and
       * `grantPlanningPermit` ranks exactly that bot first, so the wait is a tick
       * or two. `aiRepathMs` is deliberately left overdue so it keeps its claim.
       */
      if (bot.aiPath.length === 0) return zeroVec();
    } else if (bot.aiRepathMs <= 0 || targetChanged) {
      let path = findNavigationPath(this.map, bot.floorId, bot.position, target.position, bot.radius);
      let projected = false;

      if (path.length === 0) {
        const projectedPath = this.projectedInteractionPath(bot, target);
        path = projectedPath ?? [];
        projected = projectedPath !== null;
      }

      bot.aiPathTarget = { ...target.position };
      bot.aiPathFloorId = bot.floorId;
      bot.aiRepathMs = hold;
      bot.aiPathProjected = projected;

      if (path.length === 0) {
        bot.aiPath = [];
        bot.aiRepathMs = 0;

        if (target.targetId) {
          bot.aiAvoidTargets.set(target.targetId, 1800 + this.nextRandom() * 1200);
        } else if (target.intent === "wander") {
          bot.aiRetargetMs = 0;
        }

        // An empty A* result is not permission to steer through geometry — but it
        // may mean the bot is standing somewhere the planner will not plan FROM, and
        // then no objective will ever produce a path and it stands there forever.
        return this.escapeFromWedge(bot);
      }

      bot.aiPath = path.length > 1 ? path.slice(1) : [];
      bot.aiPathLegStart = { ...(path[0] ?? bot.position) };
    }

    while (bot.aiPath.length > 1 && waypointRetired(bot.position, bot.aiPathLegStart, bot.aiPath[0], bot.radius * 0.8)) {
      bot.aiPathLegStart = bot.aiPath.shift()!;
    }

    const waypoint = bot.aiPath[0] ?? target.position;
    const onFinalSegment = bot.aiPath.length <= 1;
    return steerToward(
      bot.position,
      onFinalSegment
        ? { ...target, position: waypoint, stopDistance: bot.aiPathProjected ? 1 : target.stopDistance }
        : { ...target, position: waypoint, stopDistance: 4, slowDistance: bot.radius * 2.5 },
    );
  }

  /**
   * Where to walk when the navigator will not plan from where you are.
   *
   * `findNavigationPath` tests the START point for clearance, so a bot standing
   * closer to scenery than its own radius gets an empty path to EVERYWHERE. Nothing
   * downstream distinguishes that from "the goal is unreachable": the bot blacklists
   * the objective, picks another, gets the same empty path, and works through its
   * whole list. Reported from play as a squadmate that "just sits here at the start
   * of the game and does nothing" — measured, it had blacklisted sixteen objectives
   * including the player and had moved 0 units in thirty seconds.
   *
   * Three authored spawns were inside their own clearance (22.00, 20.00 and 10.00
   * against a radius of 24) and `mapValidation.test.ts` now fails on that. This is
   * the runtime half, because authoring is not the only way in: knockback,
   * `placeBot`'s clamp against the sheet edge, revive placement and a separation
   * shove into a corner can all put a body somewhere it could not have walked.
   *
   * Deterministic and cheap: pick the nearest surface, walk directly away from it. No
   * path, no plan — this is the one situation where steering without a plan is
   * correct, because the plan is what is unavailable. Once the bot has its clearance
   * back the normal planner takes over on the next tick.
   */
  private escapeFromWedge(bot: InternalBot): Vec2 {
    const solids = this.solidsForFloor(bot.floorId);
    const clear = resolveAgainstSolids(bot.position, bot.radius + WEDGE_ESCAPE_MARGIN, solids);
    const away = subtract(clear, bot.position);
    if (length(away) > 0.001) {
      return normalize(away);
    }
    // Nothing pushed back, so the block is not local geometry — the goal really is
    // unreachable. Standing still is right, and the stall rule will re-decide.
    return zeroVec();
  }

  /**
   * Some interaction centers intentionally sit closer to scenery than a bot
   * center may. Try deterministic, interaction-safe points around them before
   * abandoning the objective; never project combat or traversal destinations.
   */
  private projectedInteractionPath(bot: InternalBot, target: AiTarget): Vec2[] | null {
    if (!target.projectionAllowed) {
      return null;
    }

    const maximumRadius =
      target.intent === "loot"
        ? target.stopDistance
        : target.intent === "revive" || target.intent === "strip"
          ? Math.max(target.stopDistance, bot.radius * 1.35)
          : 0;

    if (maximumRadius <= 1) {
      return null;
    }

    const radii = [maximumRadius, maximumRadius * 0.66, maximumRadius * 0.33];
    const directions = [
      { x: 1, y: 0 },
      { x: Math.SQRT1_2, y: Math.SQRT1_2 },
      { x: 0, y: 1 },
      { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
      { x: -1, y: 0 },
      { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
      { x: 0, y: -1 },
      { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
    ];
    const candidates = radii.flatMap((radius, ring) =>
      directions.map((direction, directionIndex) => ({
        position: add(target.position, scale(direction, radius)),
        order: ring * directions.length + directionIndex,
      })),
    );

    candidates.sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position) || a.order - b.order);

    for (const candidate of candidates) {
      const path = findNavigationPath(this.map, bot.floorId, bot.position, candidate.position, bot.radius);
      if (path.length > 0) {
        return path;
      }
    }

    return null;
  }

  /**
   * A hunter that has arrived attacks.
   *
   * This used to bail on `length(desired) < 0.01` and aim the dash down the
   * steering vector, which meant a bot that had reached its stop distance — the
   * entire point of hunting something — had no aim left and never swung. The
   * whole approach was a bot walking to a spot and then standing there. A dash
   * needs a direction, not a leftover, and the direction is the target: the gate
   * below already requires clear line of sight to it, so aiming straight at it
   * cannot fire into geometry.
   */
  private tryAiDash(bot: InternalBot, target: AiTarget): void {
    if (target.intent !== "hunt" || !target.targetId || bot.dashCooldownMs > 0 || bot.dashActiveMs > 0) {
      return;
    }

    const hostile = this.bots.get(target.targetId);
    if (!hostile || hostile.state !== "alive" || !this.canPerceive(bot, hostile.floorId, hostile.position)) {
      return;
    }

    const targetDistance = distance(bot.position, hostile.position);
    const contact = this.contactGap(bot, hostile, hostile.position);
    const insideContact = targetDistance - contact <= DASH_HIT_FORGIVENESS_PX;

    // A player can clinch a hunter too. Spend a ready dash on retreat rather
    // than throwing a harmless point-blank bump forever; the ordinary cooldown
    // then creates a readable disengage/re-entry cycle.
    if (insideContact) {
      const away = normalize(subtract(bot.position, hostile.position));
      if (length(away) < 0.5) return;
      bot.lastAim = away;
      bot.dashActiveMs = this.config.dashDurationMs;
      bot.dashCooldownMs = this.config.dashCooldownMs;
      this.recordDashStartContacts(bot);
      this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash, bot);
      return;
    }

    if (
      targetDistance > 290 ||
      !hasLineOfSight(
        this.map,
        contextKey(this.map, bot.floorId, bot.position),
        bot.position,
        hostile.position,
        this.doorOccludersForFloor(bot.floorId),
      )
    ) {
      return;
    }

    const toHostile = normalize(subtract(hostile.position, bot.position));
    if (length(toHostile) < 0.5) {
      return;
    }
    bot.lastAim = toHostile;
    bot.dashActiveMs = this.config.dashDurationMs;
    bot.dashCooldownMs = this.config.dashCooldownMs + 250 + this.nextRandom() * 450;
    this.recordDashStartContacts(bot);
    this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash, bot);
  }

  /**
   * Indoor bots wander their own FLOOR's extent; outdoor bots wander the map.
   *
   * The floor rather than the building, because a level below ground can reach past the
   * mass standing on it. On the temple's undercroft the building footprint is the pyramid,
   * so a bot two hundred units down a tunnel picked a wander target back inside a shape it
   * was standing outside of, over and over.
   */
  private pickWanderTarget(bot: InternalBot): Vec2 {
    const bounds =
      bot.floorId !== OUTDOOR_FLOOR_ID
        ? floorPlanById(this.map, bot.floorId)?.bounds
          ?? this.map.buildings.find((building) => building.floors.some((floor) => floor.id === bot.floorId))?.footprint
        : buildingContaining(this.map, bot.position)?.footprint;

    if (bounds) {
      const margin = 60;
      return {
        x: bounds.x + margin + this.nextRandom() * (bounds.w - margin * 2),
        y: bounds.y + margin + this.nextRandom() * (bounds.h - margin * 2),
      };
    }

    return {
      x: 90 + this.nextRandom() * (this.map.width - 180),
      y: 90 + this.nextRandom() * (this.map.height - 180),
    };
  }

  private applyMovement(dtMs: number): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive") {
        // Corpses are immovable by construction: no integration, no forces.
        bot.velocity = zeroVec();
        bot.moveVelocity = zeroVec();
        bot.knockbackMs = 0;
        continue;
      }

      const frozen = this.controllers.get(bot.id) === "frozen" || bot.activeSwap;
      const speed =
        bot.dashActiveMs > 0
          ? this.config.dashSpeed
          : this.controllers.get(bot.id) === "human"
            ? this.config.playerSpeed
            : this.config.botSpeed;
      /**
       * A body channel does not pin you.
       *
       * It used to: anyone whose coverage was open had their movement zeroed until
       * it finished, which from the keyboard is indistinguishable from being stuck —
       * you walk onto a downed bot and the controls go dead for three seconds. The
       * channel never needed it. `resolveDownedCoverage` re-tests the range every
       * tick and deletes the coverage the moment the coverer steps off, so standing
       * still is already the requirement and walking away is already the cancel.
       * Taking the force away turns a lockout back into a decision.
       *
       * The swap channel keeps its hold, via `frozen`: that one is authored as a two
       * second stationary, noisy commitment rather than something you hold by
       * standing on it.
       */
      const direction = frozen ? zeroVec() : bot.dashActiveMs > 0 ? bot.lastAim : bot.desiredMove;
      let velocity = scale(direction, speed);
      bot.moveVelocity = velocity;

      // Bounded, decaying knockback replaces the old solver shove.
      if (bot.knockbackMs > 0) {
        velocity = add(velocity, scale(bot.knockbackVel, bot.knockbackMs / this.config.knockbackDurationMs));
        bot.knockbackMs = Math.max(0, bot.knockbackMs - dtMs);
      }
      bot.velocity = velocity;

      // Shield plates follow the direction of travel.
      if (length(direction) > 0.05) {
        bot.facing = Math.atan2(direction.y, direction.x);
      }

      const solids = this.solidsForFloor(bot.floorId);
      const next = integrateWithWalls(bot.position, velocity, dtMs, bot.radius, solids);
      this.placeBot(bot, next);
    }
  }

  /**
   * Alive bots shoulder past each other at a capped rate instead of trading
   * solver impulses; a downed body is walkable and immovable.
   * Responsibility is velocity-gated: the MOVER yields, a standing bot (or a
   * channel-frozen looter) is an anchor that cannot be shoved. Both moving
   * splits the overlap evenly.
   */
  private resolveBotSeparation(dtMs: number): void {
    const maxPushPx = (this.config.botSeparationSpeed * dtMs) / 1000;
    const aliveBots = [...this.bots.values()]
      .filter((bot) => bot.state === "alive")
      .sort((left, right) => left.id.localeCompare(right.id));

    for (let i = 0; i < aliveBots.length; i += 1) {
      for (let j = i + 1; j < aliveBots.length; j += 1) {
        const a = aliveBots[i];
        const b = aliveBots[j];
        if (a.floorId !== b.floorId) {
          continue;
        }
        const aMoving = length(a.velocity) > MOVING_SPEED;
        const bMoving = length(b.velocity) > MOVING_SPEED;
        const yieldA = aMoving === bMoving ? 0.5 : aMoving ? 1 : 0;
        const yieldB = aMoving === bMoving ? 0.5 : bMoving ? 1 : 0;
        /**
         * Bodies push apart at the distance their real silhouettes touch, so a bot
         * with a plate missing is genuinely smaller on that side and another body
         * comes to rest against its bare core. A bot is not a circle.
         *
         * Separating at the full radius instead leaves what play reported as "an
         * invisible barrier around the core": you stop 48 units from the centre of
         * a bot whose core surface is at 9.6, with thirty-odd units of nothing in
         * between.
         *
         * Separating at the SUM OF TWO RAY REACHES was the next attempt and it is
         * what welded bodies together. That predicate is necessary and not
         * sufficient — see `contactGap` — so the solver had a stable, force-free,
         * OVERLAPPING resting place, and once a pair found it nothing on the tick
         * ever pushed them apart again.
         *
         * The distance moves as either bot turns, which is real and is bounded:
         * `contactDistance` is always inside [core+core, radius+radius], so no turn
         * of any size can change it by more than 28.8 units, and the pair closes
         * that at 10 units a tick. Worst case is three ticks of jostling while
         * somebody swings a good plate round to meet you. Which is what turning
         * into a threat ought to feel like.
         *
         * *World* collision deliberately does not do this: a body that shrinks
         * against static geometry can enter gaps the navigator plans around at full
         * radius and then has no route out. Bots have no such planner between them.
         */
        const span = a.radius + b.radius;
        if (Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y) >= span) {
          // No pose of any two bodies requires more than both full radii, so this
          // retires the overwhelming majority of pairs before any geometry runs.
          continue;
        }
        const awayFromB = separationAxis(a.position, b.position, coincidentSeparationAxis(a.id, b.id));
        const awayFromA = scale(awayFromB, -1);
        const need = this.contactGapAlong(a, b, -awayFromB.x, -awayFromB.y);
        const pushA = separationPush(a.position, b.position, need, maxPushPx, yieldA, awayFromB);
        const pushB = separationPush(b.position, a.position, need, maxPushPx, yieldB, awayFromA);
        if (pushA.x === 0 && pushA.y === 0 && pushB.x === 0 && pushB.y === 0) {
          continue;
        }
        /**
         * A wall can eat all or part of a yielder's correction, and the yield
         * split means nobody else was going to try. Measured: 28.0 px of
         * PERMANENT interpenetration against a flat wall, 31.03 px in a 60x60
         * dead-end pocket, both unchanged after 30 ticks — the mover's push was
         * the wall normal, `resolveAgainstSolids` cancelled 100% of it, and the
         * anchor's yield of 0 meant the pair simply stayed welded.
         *
         * So measure what the world actually delivered and hand the shortfall to
         * the counterpart in the same tick. Not a constraint solver — one relay
         * each way, and each body still capped at `maxPushPx` for the tick, so a
         * body pinned on both sides stays pinned instead of squirting out.
         */
        const solids = this.solidsForFloor(a.floorId);
        const wantA = length(pushA);
        const gotA = this.pushBotBy(a, pushA, awayFromB, solids);
        const wantB = length(pushB);
        const relayToB = Math.max(0, Math.min(wantA - gotA, maxPushPx - wantB));
        const gotB = this.pushBotBy(b, add(pushB, scale(awayFromA, relayToB)), awayFromA, solids);
        const relayToA = Math.max(0, Math.min(wantB + relayToB - gotB, maxPushPx - Math.max(gotA, 0)));
        if (relayToA > 0) {
          this.pushBotBy(a, scale(awayFromB, relayToA), awayFromB, solids);
        }
      }
    }
  }

  /** Move `bot` by `push` and report how much of it the world let through,
   * measured along `axis`. Zero back means a wall took the whole thing. */
  private pushBotBy(bot: InternalBot, push: Vec2, axis: Vec2, solids: SolidSource): number {
    if (push.x === 0 && push.y === 0) {
      return 0;
    }
    const before = bot.position;
    this.placeBot(bot, resolveAgainstSolids(add(bot.position, push), bot.radius, solids));
    return (bot.position.x - before.x) * axis.x + (bot.position.y - before.y) * axis.y;
  }

  /** Single write path for bot positions, clamped to the sheet. */
  private placeBot(bot: InternalBot, position: Vec2): void {
    bot.position = {
      x: clamp(position.x, this.config.botRadius, this.map.width - this.config.botRadius),
      y: clamp(position.y, this.config.botRadius, this.map.height - this.config.botRadius),
    };
  }


  /**
   * Stairs are walk-through: the two floors share the shaft's coordinates, so
   * crossing the run's midline (the break line on the plan) while inside the
   * stair swaps the bot's floor mid-stride — no teleport. Walking back across
   * the midline descends again via the paired stair on the other floor.
   * Player and AI use the same geometry and transition rules.
   */
  private resolveStairs(): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive") {
        continue;
      }

      for (const stair of this.stairsByFloor.get(bot.floorId) ?? []) {
        if (!rectContainsPoint(stair.rect, bot.position) || !rectContainsPoint(stair.rect, bot.prevPosition)) {
          continue;
        }

        const { entry, exit } = stairHalves(stair);

        if (!rectContainsPoint(entry, bot.prevPosition) || !rectContainsPoint(exit, bot.position)) {
          continue;
        }

        const sourceFloor = bot.floorId;
        const targetFloor = physicsFloorId(this.map, stair.toFloorId);
        bot.floorId = targetFloor;
        bot.aiPath = [];
        bot.aiRepathMs = 0;
        bot.aiPathProjected = false;

        // Stairs announce themselves on both connected floors.
        this.emitNoise("stairs", bot.position, sourceFloor, NOISE_LOUDNESS.stairs, bot);
        this.emitNoise("stairs", bot.position, targetFloor, NOISE_LOUDNESS.stairs, bot);
        break;
      }
    }
  }

  private recordPositionHistory(): void {
    for (const bot of this.bots.values()) {
      bot.positionHistory.push({ position: { ...bot.position }, floorId: bot.floorId });
      if (bot.positionHistory.length > MAX_REWIND_TICKS + 1) {
        bot.positionHistory.splice(0, bot.positionHistory.length - (MAX_REWIND_TICKS + 1));
      }
    }
  }

  /** The victim as the attacker perceived it `viewDelayTicks` ago. Falls back
   * to the present when the history is short or the victim changed floors. */
  private perceivedTarget(attacker: InternalBot, victim: InternalBot): { position: Vec2; floorId: string } {
    const rewind = Math.min(attacker.viewDelayTicks, victim.positionHistory.length - 1);
    if (rewind <= 0) {
      return { position: victim.position, floorId: victim.floorId };
    }
    return victim.positionHistory[victim.positionHistory.length - 1 - rewind];
  }

  /** Contact test for a directed attack, lag-compensated to the attacker's
   * view of the victim and SWEPT along the attacker's full tick of travel so
   * a 640px/s dash cannot step across the contact window between samples.
   * The attacker's own position is always present-time — with client
   * prediction it already matches what they see of themselves. */
  private attackConnects(attacker: InternalBot, victim: InternalBot): boolean {
    const perceived = this.perceivedTarget(attacker, victim);
    if (perceived.floorId !== attacker.floorId) {
      return false;
    }
    const sweep = pointSegmentDistance(perceived.position, attacker.prevPosition, attacker.position);
    return sweep - this.contactGap(attacker, victim, perceived.position) <= DASH_HIT_FORGIVENESS_PX;
  }

  /** Record target-specific point-blank contacts on the dash input edge. */
  private recordDashStartContacts(attacker: InternalBot): void {
    attacker.dashBlockedTargets.clear();
    for (const victim of this.bots.values()) {
      if (victim.id === attacker.id || victim.state !== "alive" || areFriendly(attacker, victim)) continue;
      const perceived = this.perceivedTarget(attacker, victim);
      if (perceived.floorId !== attacker.floorId) continue;
      const gap = distance(attacker.position, perceived.position)
        - this.contactGap(attacker, victim, perceived.position);
      if (gap <= DASH_START_CONTACT_EPSILON_PX) attacker.dashBlockedTargets.add(victim.id);
    }
  }

  private impactMeetsIntactPlate(target: InternalBot, source: InternalBot): boolean {
    if (target.shieldSegments.length === 0) return false;
    const impactAngle = Math.atan2(
      source.position.y - target.position.y,
      source.position.x - target.position.x,
    );
    const plate = coveringPlate(target.facing, target.shieldSegments.length, impactAngle);
    return target.shieldSegments[plate] > 0;
  }

  /**
   * How close two bots have to be to touch, given which way each is facing and
   * which plates each still has.
   *
   * Not `attacker.radius + victim.radius`. That circle is nowhere on either bot:
   * the plates are drawn well inside it, so a dash "connected" while the two were
   * still visibly apart, and a bot stripped of its plates was every bit as wide as
   * one with all three. Both bots contribute their own reach along the line
   * between them, so closing on a bare core means actually getting to the core.
   */
  /**
   * How close a hunting bot has to get before its dash can land.
   *
   * A flat `radius * 1.85` was right while every bot was the same circle, then it
   * became `min(radius * 1.85, gap)` = min(44.4, gap) when bodies stopped being
   * circles. The clamp only ever bit at gap 48 — two live plates facing each
   * other, the ordinary case — so a hunter was told to stand 3.6 units INSIDE the
   * distance the separation solver holds. Measured: pinned there for 815 of 900
   * ticks, creeping 0.1585 px/tick in and being shoved 0.1585 px/tick back out,
   * forever. Worse than the jitter, that is 9.5 px/s of standing still, over the
   * 5 px/s moving threshold, so a hunter parked on a target read as MOVING, yielded
   * 1.0 to every other body, and could never become an anchor.
   *
   * The run-up rule changes that contract: arriving at contact produces a bump,
   * not damage. Hold station just outside the shared contact-forgiveness ring so
   * a hunter visibly closes distance when it attacks.
   */
  private huntStopDistance(bot: InternalBot, target: InternalBot): number {
    return this.contactGap(bot, target, target.position) + AI_DASH_RUN_UP_PX;
  }

  /**
   * How far apart two bodies have to be, centre to centre, to be just touching
   * along the line between them.
   *
   * The one base number every consumer shares: the separation pass, the attack
   * test, where a connecting dash stops, and the hunter's run-up measured beyond
   * it. They must agree or the game argues with itself — a steer that arrives
   * inside the distance the solver holds is a permanent push-war, and a dash that
   * stops at a distance the hit test never called contact is a ghost pass-through.
   *
   * NOT `contactReach(a, u) + contactReach(b, -u)`. That sum is what welded bodies
   * together: it samples a single ray of a body that is a core disc with plate
   * sectors bolted on, so it is blind to the plates either side of the notch it
   * happens to be pointing down. 31% of poses satisfied it while the two bodies
   * genuinely intersected. It survives here only as the seed — it is a valid lower
   * bound, so it prunes most of the search.
   */
  private contactGap(a: InternalBot, b: InternalBot, bAt: Vec2): number {
    const dx = bAt.x - a.position.x;
    const dy = bAt.y - a.position.y;
    const dist = Math.hypot(dx, dy);
    return dist > 0.001
      ? this.contactGapAlong(a, b, dx / dist, dy / dist)
      : this.contactGapAlong(a, b, 1, 0);
  }

  /** The same distance along a direction the caller already has. Separation has
   * one — including at coincident centres, where it is invented and both bodies
   * have to be told the same story. */
  private contactGapAlong(a: InternalBot, b: InternalBot, ux: number, uy: number): number {
    const toB = Math.atan2(uy, ux);
    const seed = contactReach(a.radius, a.facing, a.shieldSegments, toB)
      + contactReach(b.radius, b.facing, b.shieldSegments, toB + Math.PI);
    return contactDistance(this.shapeOf(a), this.shapeOf(b), ux, uy, seed);
  }

  /** This bot's convex decomposition, rebuilt only when its pose has moved on. */
  private shapeOf(bot: InternalBot): ContactShape {
    const segments = bot.shieldSegments;
    let stale = bot.shapeFacing !== bot.facing || bot.shapeSegments.length !== segments.length;
    for (let index = 0; !stale && index < segments.length; index += 1) {
      stale = bot.shapeSegments[index] !== segments[index];
    }
    if (stale) {
      buildContactShape(bot.contactShape, bot.radius, bot.facing, segments);
      bot.shapeFacing = bot.facing;
      bot.shapeSegments.length = segments.length;
      for (let index = 0; index < segments.length; index += 1) {
        bot.shapeSegments[index] = segments[index];
      }
    }
    return bot.contactShape;
  }

  /**
   * A connecting dash ends at its target: the attack reads as an impact, not
   * a ghost pass-through. Contact is resolved against the same rewound target
   * position used by hit validation. Snapping against the victim's newer
   * present-time body made valid lag-compensated hits stop at a different
   * place than the attacker had actually seen.
   */
  private stopDashAtContact(attacker: InternalBot, victim: InternalBot): void {
    attacker.dashActiveMs = 0;
    const target = this.perceivedTarget(attacker, victim).position;
    // The same reach the hit test used, or a dash stops at a distance the contact
    // test never agreed was contact.
    const touching = this.contactGap(attacker, victim, target);
    const travel = subtract(attacker.position, attacker.prevPosition);
    const fromTarget = subtract(attacker.prevPosition, target);
    const travelLengthSquared = travel.x * travel.x + travel.y * travel.y;
    let contact: Vec2;

    // Earliest segment/circle intersection keeps the attacker on the entry
    // side of the target instead of allowing a one-tick pass-through and
    // snapping back from the far side.
    const b = 2 * (fromTarget.x * travel.x + fromTarget.y * travel.y);
    const c = fromTarget.x * fromTarget.x + fromTarget.y * fromTarget.y - touching * touching;
    const discriminant = b * b - 4 * travelLengthSquared * c;
    if (travelLengthSquared > 0.0001 && discriminant >= 0) {
      const entry = clamp((-b - Math.sqrt(discriminant)) / (2 * travelLengthSquared), 0, 1);
      contact = add(attacker.prevPosition, scale(travel, entry));
    } else {
      // The hit test permits a four-pixel forgiveness ring. For that narrow
      // miss, magnetize to the closest point on the swept segment.
      const projected = travelLengthSquared > 0.0001
        ? clamp(-(fromTarget.x * travel.x + fromTarget.y * travel.y) / travelLengthSquared, 0, 1)
        : 0;
      const nearest = add(attacker.prevPosition, scale(travel, projected));
      const normal = subtract(nearest, target);
      const normalLength = length(normal);
      const direction = normalLength > 0.001 ? scale(normal, 1 / normalLength) : { x: 1, y: 0 };
      contact = add(target, scale(direction, touching));
    }
    const solids = this.solidsForFloor(attacker.floorId);
    this.placeBot(attacker, resolveAgainstSolids(contact, attacker.radius, solids));
  }

  /** Bounded physical separation shared by a point-blank bump and a clash. */
  private recoilDashContact(a: InternalBot, b: InternalBot): Vec2 {
    const direction = normalize(subtract(b.position, a.position));
    const axis = length(direction) > 0.001
      ? direction
      : coincidentSeparationAxis(a.id, b.id);
    a.knockbackVel = scale(axis, -this.config.knockbackSpeed);
    b.knockbackVel = scale(axis, this.config.knockbackSpeed);
    a.knockbackMs = this.config.knockbackDurationMs;
    b.knockbackMs = this.config.knockbackDurationMs;
    return axis;
  }

  private disengageAiAfterClash(bot: InternalBot, opponent: InternalBot): void {
    if (this.controllers.get(bot.id) !== "ai") return;
    bot.aiAvoidTargets.set(
      opponent.id,
      AI_CLASH_DISENGAGE_MS + this.nextRandom() * AI_CLASH_DISENGAGE_MS,
    );
    bot.aiPath = [];
    bot.aiRepathMs = 0;
  }

  private emitDashContact(
    a: InternalBot,
    b: InternalBot,
    result: "bump" | "clash",
    direction: Vec2,
  ): void {
    const position = scale(add(a.position, b.position), 0.5);
    this.emitNoise("impact", position, a.floorId, NOISE_LOUDNESS.impact);
    this.events.push({
      type: "dashContact",
      botId: b.id,
      byBotId: a.id,
      result,
      position,
      direction,
      tick: this.tickCount,
    });
  }

  private resolveCombat(): void {
    const aliveBots = [...this.bots.values()].filter((bot) => bot.state === "alive");

    for (let i = 0; i < aliveBots.length; i += 1) {
      for (let j = i + 1; j < aliveBots.length; j += 1) {
        const a = aliveBots[i];
        const b = aliveBots[j];

        // No friendly fire: squadmates bump, never wound each other.
        if (areFriendly(a, b)) {
          continue;
        }

        const aDashing = a.dashActiveMs > 0;
        const bDashing = b.dashActiveMs > 0;

        if (aDashing || bDashing) {
          // Dashes are the attack verb: each direction is tested against the
          // victim as the attacker saw them (lag compensated), so a dash
          // through the enemy on screen lands even though the wire is late.
          // A connecting dash STOPS at its target instead of ghosting on.
          const aConnects = aDashing && this.attackConnects(a, b);
          const bConnects = bDashing && this.attackConnects(b, a);
          const aStartedTouching = a.dashBlockedTargets.has(b.id);
          const bStartedTouching = b.dashBlockedTargets.has(a.id);
          const aBlocked = aConnects && aStartedTouching && this.ramSpeedToward(a, b) > 0;
          const bBlocked = bConnects && bStartedTouching && this.ramSpeedToward(b, a) > 0;
          const aCanHit = aConnects && !aStartedTouching;
          const bCanHit = bConnects && !bStartedTouching;
          const aArmed = aDashing && !aStartedTouching;
          const bArmed = bDashing && !bStartedTouching;
          const opposingDashes = this.ramSpeedToward(a, b) > 0
            && this.ramSpeedToward(b, a) > 0;

          // Both bots spent the same attack verb from clear space and are
          // driving into one another. The first connecting sweep resolves the
          // pair: requiring BOTH lag-compensated sweeps on the same 60 Hz tick
          // made a parry depend on identical clocks rather than overlapping,
          // opposing dashes.
          if (
            aArmed
            && bArmed
            && (aConnects || bConnects)
            && opposingDashes
            && this.impactMeetsIntactPlate(a, b)
            && this.impactMeetsIntactPlate(b, a)
          ) {
            if (aConnects) this.stopDashAtContact(a, b);
            else a.dashActiveMs = 0;
            if (bConnects) this.stopDashAtContact(b, a);
            else b.dashActiveMs = 0;
            const direction = this.recoilDashContact(a, b);
            this.disengageAiAfterClash(a, b);
            this.disengageAiAfterClash(b, a);
            this.emitDashContact(a, b, "clash", direction);
            continue;
          }

          let bumped = false;
          if (aBlocked) {
            this.stopDashAtContact(a, b);
            bumped = true;
          } else if (aCanHit) {
            if (this.damageBot(b, a)) {
              this.stopDashAtContact(a, b);
            }
          }
          if (bBlocked) {
            this.stopDashAtContact(b, a);
            bumped = true;
          } else if (bCanHit) {
            if (this.damageBot(a, b)) {
              this.stopDashAtContact(b, a);
            }
          }
          if (bumped) {
            const direction = this.recoilDashContact(a, b);
            if (aBlocked || !bBlocked) {
              this.emitDashContact(a, b, "bump", direction);
            } else {
              this.emitDashContact(b, a, "bump", scale(direction, -1));
            }
          }
          continue;
        }

        if (a.floorId !== b.floorId) {
          continue;
        }

        /**
         * The ram: a body driving itself into another at dash-class speed hurts it,
         * even outside a dash window. Two conditions, and both had to be added.
         *
         * Reported twice from play: "this bot was just a core and he hit me, broke my
         * shield, but died himself without me dashing at all." Instrumented, on the
         * shipped map, with a human who keeps walking:
         *
         *   t1713  RAM player -> enemy-4  |vel| 550  knockMs 123  closing -550
         *          targetPlates 000  << TARGET DIED
         *
         * The stripped attacker's dash connected and broke a plate. The hit knocked
         * the player back at `knockbackSpeed` 320, and `bot.velocity` is movement PLUS
         * knockback — so the player was carrying 230 + 320 = 550 with neither body
         * dashing, still inside the four-unit contact band because a wall was taking
         * the displacement, and this rule handed the faster body the hit. Against an
         * attacker with nothing left, one hit anywhere is fatal. So the attacker died
         * of the knockback it had itself caused, and the player never pressed a key.
         *
         * Hence: ram speed is the body's OWN movement, because wearing a shove is not
         * attacking and knockback is meant to be bounded feedback rather than a
         * weapon. And the rammer has to be CLOSING — knockback points straight away
         * from whoever landed the hit, so the "rammer" was travelling backwards at
         * 550. Every ram hit in that measurement had a negative closing speed.
         *
         * A first attempt at this was reverted for want of evidence, on a measurement
         * taken where the human never moved — and a body standing still cannot reach
         * 360 on knockback alone. Only a walker can. The scenario matters as much as
         * the instrument.
         */
        const gap = distance(a.position, b.position) - a.radius - b.radius;
        if (gap > 4) {
          continue;
        }
        const aRam = this.ramSpeedToward(a, b);
        const bRam = this.ramSpeedToward(b, a);
        if (Math.max(aRam, bRam) < this.config.damageSpeed) {
          continue;
        }

        if (aRam > bRam + 20) {
          this.damageBot(b, a);
        } else if (bRam > aRam + 20) {
          this.damageBot(a, b);
        } else {
          this.damageBot(a, b);
          this.damageBot(b, a);
        }
      }
    }
  }

  /**
   * How fast `bot` is driving itself INTO `other`, in px/s.
   *
   * Its own movement only — `moveVelocity`, not `velocity` — and only the component
   * pointing at the other body. Zero if it is moving away, however fast it is going.
   */
  private ramSpeedToward(bot: InternalBot, other: InternalBot): number {
    const dx = other.position.x - bot.position.x;
    const dy = other.position.y - bot.position.y;
    const away = Math.hypot(dx, dy);
    if (away < 0.001) {
      return length(bot.moveVelocity);
    }
    return Math.max(0, (bot.moveVelocity.x * dx + bot.moveVelocity.y * dy) / away);
  }

  /** Applies one hit; returns whether damage actually landed (false while
   * the target is invulnerable or already down). */
  private damageBot(target: InternalBot, source: InternalBot): boolean {
    if (target.id === source.id || target.state !== "alive" || target.invulnerabilityMs > 0) {
      return false;
    }

    // The hit lands in one plate's arc. A live plate breaks; a broken arc is not
    // there any more, so the hit reaches the core (see shields.ts for the model).
    const impactAngle = Math.atan2(source.position.y - target.position.y, source.position.x - target.position.x);
    const armourHit = applyArmourHit(target.facing, target.shieldSegments, impactAngle);
    target.shields = plateSum(target.shieldSegments);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    this.emitNoise("impact", target.position, target.floorId, NOISE_LOUDNESS.impact);
    const away = { x: -Math.cos(impactAngle), y: -Math.sin(impactAngle) };
    const result = armourHit.core ? "downed" : "plateBreak";
    // A dedicated acknowledgement lets the attacking client correlate its
    // instant predicted contact with the exact authoritative result. It also
    // carries the presentation normal so clients never wait on a later
    // position snapshot to show the physical response.
    this.events.push({
      type: "hit",
      botId: target.id,
      byBotId: source.id,
      result,
      position: {
        x: target.position.x - away.x * target.radius,
        y: target.position.y - away.y * target.radius,
      },
      direction: away,
      tick: this.tickCount,
    });

    if (armourHit.core) {
      // Losing every plate is not what puts a bot down — being hit where a plate
      // used to be is. A stripped bot can still run, still extract, still be saved.
      this.putBotDown(target, source.id);
      return true;
    }

    // Readable, bounded hit feedback replacing the solver shove.
    target.knockbackVel = scale(away, this.config.knockbackSpeed);
    target.knockbackMs = this.config.knockbackDurationMs;
    return true;
  }

  private resolveDotCapture(dtMs: number): void {
    const aliveBots = [...this.bots.values()].filter((bot) => bot.state === "alive" && !bot.isAmbient);

    for (const dot of this.dots.values()) {
      if (!dot.active) {
        continue;
      }

      const coveringBot = aliveBots.find(
        (bot) =>
          bot.floorId === dot.floorId &&
          withinInteractionDotRange(bot.position, bot.radius, dot.position, dot.radius),
      );

      if (!coveringBot) {
        dot.captureProgressMs = Math.max(0, dot.captureProgressMs - dtMs * 0.65);
        dot.capturedBy = undefined;
        continue;
      }

      if (dot.capturedBy !== coveringBot.id) {
        dot.capturedBy = coveringBot.id;
        dot.captureProgressMs = 0;
      }

      dot.captureProgressMs += dtMs;

      if (this.channelPingDue(dot.captureProgressMs, dtMs)) {
        this.emitNoise("channel", dot.position, dot.floorId, NOISE_LOUDNESS.captureChannel, coveringBot);
      }

      this.coverages.set(`capture:${dot.id}`, {
        kind: "capture",
        actorId: coveringBot.id,
        targetId: dot.id,
        progressMs: dot.captureProgressMs,
        durationMs: this.config.dotCaptureDurationMs,
      });

      if (dot.captureProgressMs >= this.config.dotCaptureDurationMs) {
        const inserted = insertItem(coveringBot, { ...dot.item }, this.config.holdSlots);
        if (inserted) {
          dot.active = false;
          this.events.push({ type: "dotCaptured", botId: coveringBot.id, dotId: dot.id });
        } else {
          dot.captureProgressMs = 0;
          dot.capturedBy = undefined;
        }
        this.coverages.delete(`capture:${dot.id}`);
      }
    }

    for (const [key, coverage] of this.coverages) {
      if (coverage.kind === "capture") {
        const dot = this.dots.get(coverage.targetId);
        if (!dot?.active || dot.captureProgressMs <= 0) {
          this.coverages.delete(key);
        }
      }
    }
  }

  private resolveDownedCoverage(dtMs: number): void {
    // Humans outrank AI for the coverage slot: an AI wingmate hovering the
    // same body must never silently swallow the player's loot/revive channel.
    const aliveBots = [...this.bots.values()]
      .filter((bot) => bot.state === "alive" && !bot.isAmbient)
      .sort((left, right) => {
        const leftHuman = this.controllers.get(left.id) === "human" ? 0 : 1;
        const rightHuman = this.controllers.get(right.id) === "human" ? 0 : 1;
        return leftHuman - rightHuman || left.id.localeCompare(right.id);
      });
    const downedBots = [...this.bots.values()].filter((bot) => bot.state === "downed");

    /**
     * One body per pair of hands.
     *
     * This used to be decided the other way round — every downed body looked for
     * anyone standing on it — so a bot straddling two bodies opened a channel on
     * BOTH from one press. Play reported the consequence and read it as an overlap
     * bug, which it was: "when I press F over top of these two downed bots, the
     * search bar appears then disappears."
     *
     * It disappears because the overlay clears the verb whenever the body it is
     * prompting for changes, which is right — otherwise one press of F latches and
     * every body walked over afterwards searches itself. With two channels running,
     * the overlay showed whichever coverage happened to sit first in the array, that
     * was not the body the player had chosen, and the mismatch cancelled the verb one
     * frame later.
     *
     * So an actor claims its NEAREST body in range, by the same centre distance the
     * overlay sorts by, and covers only that one. Two agreeing rules instead of two
     * disagreeing ones.
     */
    const claim = new Map<string, string>();
    for (const bot of aliveBots) {
      let nearest: InternalBot | null = null;
      let nearestAway = Infinity;
      for (const downed of downedBots) {
        if (bot.id === downed.id || bot.floorId !== downed.floorId) continue;
        if (!withinDownedCoverRange(bot.position, bot.radius, downed.position, downed.radius, this.config.coverCenterTolerance)) {
          continue;
        }
        const away = distance(bot.position, downed.position);
        // Ties break on id so the server and the overlay cannot disagree about which
        // of two exactly-coincident bodies is "nearest".
        if (away < nearestAway || (away === nearestAway && nearest !== null && downed.id < nearest.id)) {
          nearest = downed;
          nearestAway = away;
        }
      }
      if (nearest) claim.set(bot.id, nearest.id);
    }

    for (const downed of downedBots) {
      const coveringBot = aliveBots.find((bot) => claim.get(bot.id) === downed.id);
      const coverageKey = `downed:${downed.id}`;

      if (!coveringBot) {
        this.coverages.delete(coverageKey);
        continue;
      }

      let kind: CoverageKind;
      if (areFriendly(coveringBot, downed)) {
        // A squadmate is here to pick you up. There is nothing to choose.
        kind = "revive";
      } else if (this.inputs.get(coveringBot.id)?.downedVerb === "revive" && !this.canRecruit(coveringBot, downed)) {
        // Asked to pick up a rival who did not plead, or whose squad is full. Refusing
        // the channel here rather than at the end is what keeps the overlay honest —
        // it reads the same predicate, so it never offers this in the first place.
        this.coverages.delete(coverageKey);
        continue;
      } else {
        const controller = this.controllers.get(coveringBot.id);
        // An AI standing over a body strips it and moves on. It cannot finish the
        // body off, because nothing can.
        const verb = controller === "human" ? this.inputs.get(coveringBot.id)?.downedVerb : "loot";
        if (!verb) {
          this.coverages.delete(coverageKey);
          continue;
        }
        // A verb is standing state: it persists until the player picks the other
        // one. So a body that has already been searched must refuse the channel,
        // or holding LOOT re-opens the same body every three seconds forever.
        if (verb === "loot" && downed.searched) {
          this.coverages.delete(coverageKey);
          continue;
        }
        kind = verb;
      }
      const durationMs = kind === "loot" ? this.config.lootDurationMs : this.config.coverDurationMs;

      const existing = this.coverages.get(coverageKey);
      const progressMs = existing?.actorId === coveringBot.id && existing.kind === kind ? existing.progressMs + dtMs : dtMs;

      if (this.channelPingDue(progressMs, dtMs)) {
        this.emitNoise("channel", downed.position, downed.floorId, NOISE_LOUDNESS.coverChannel, coveringBot);
      }

      this.coverages.set(coverageKey, {
        kind,
        actorId: coveringBot.id,
        targetId: downed.id,
        progressMs,
        durationMs,
      });

      if (progressMs >= durationMs) {
        // Looting leaves the body where it is. Wanting both is two channels, which
        // is what the compound verb used to hide.
        if (kind === "loot") {
          this.searchBody(downed, coveringBot);
          // An AI does not browse a body. A player gets a picker; an AI sweeps
          // what fits and walks away, which is the same behaviour it always had.
          if (this.controllers.get(coveringBot.id) !== "human") {
            this.takeFromBody(coveringBot, { fromBotId: downed.id, index: "all" });
          }
        } else {
          this.reviveBot(downed, coveringBot);
        }

        this.coverages.delete(coverageKey);
      }
    }
  }

  private resolveExtraction(dtMs: number): void {
    const activeKeys = new Set<string>();

    for (const bot of this.bots.values()) {
      if (bot.isAmbient || bot.state !== "alive" || bot.floorId !== OUTDOOR_FLOOR_ID || carriedCount(bot) <= 0) {
        continue;
      }

      const point = this.map.extractionPoints.find((candidate) => rectContainsPoint(candidate.rect, bot.position));
      if (!point) {
        continue;
      }

      const coverageKey = `extract:${bot.id}`;
      activeKeys.add(coverageKey);
      const existing = this.coverages.get(coverageKey);
      const progressMs = existing?.targetId === point.id ? existing.progressMs + dtMs : dtMs;

      if (this.channelPingDue(progressMs, dtMs)) {
        this.emitNoise("channel", bot.position, bot.floorId, NOISE_LOUDNESS.extractChannel, bot);
      }

      this.coverages.set(coverageKey, {
        kind: "extract",
        actorId: bot.id,
        targetId: point.id,
        progressMs,
        durationMs: this.config.extractionDurationMs,
      });

      if (progressMs >= this.config.extractionDurationMs) {
        this.events.push({ type: "extracted", botId: bot.id, squadId: bot.squadId, items: carriedItems(bot) });
        this.removeBot(bot.id);
      }
    }

    for (const [key, coverage] of this.coverages) {
      if (coverage.kind === "extract" && !activeKeys.has(key)) {
        this.coverages.delete(key);
      }
    }
  }

  private resolveSwaps(dtMs: number): void {
    for (const bot of this.bots.values()) {
      const swap = bot.activeSwap;
      const key = `swap:${bot.id}`;
      if (!swap || bot.state !== "alive") {
        this.coverages.delete(key);
        bot.activeSwap = undefined;
        continue;
      }
      swap.progressMs += dtMs;
      bot.desiredMove = zeroVec();
      if (this.channelPingDue(swap.progressMs, dtMs)) {
        this.emitNoise("channel", bot.position, bot.floorId, NOISE_LOUDNESS.coverChannel, bot);
      }
      this.coverages.set(key, {
        kind: "swap",
        actorId: bot.id,
        targetId: String(swap.holdIndex),
        progressMs: swap.progressMs,
        durationMs: this.config.swapDurationMs,
      });
      if (swap.progressMs >= this.config.swapDurationMs) {
        const held = bot.hold[swap.holdIndex];
        if (held) {
          const bayItem = bot.bays[swap.bayIndex];
          bot.bays[swap.bayIndex] = held;
          if (bayItem) bot.hold[swap.holdIndex] = bayItem;
          else bot.hold.splice(swap.holdIndex, 1);
        }
        bot.activeSwap = undefined;
        this.coverages.delete(key);
      }
    }
  }

  private reviveBot(target: InternalBot, reviver: InternalBot): void {
    /**
     * Picking up a rival who asked for it recruits them.
     *
     * Squads load in at three and the cap is four, so this is the only way a squad ever
     * grows — and the only way a bot ever changes side. Gated on the plea by
     * `canReviveBody`, which the overlay reads too: a squad you did not ask to join
     * would be a capture, not a rescue.
     *
     * Changing `squadId` is the whole of it. `areFriendly` is squad equality, so
     * friend-or-foe, no-friendly-fire, revive-versus-strip, squad vision and the AI's
     * own target selection all follow from this line without knowing it happened.
     */
    if (!areFriendly(reviver, target)) {
      const from = target.squadId;
      target.squadId = reviver.squadId;
      // Their objective was chosen as a rival's. It is not one any more.
      target.aiPath = [];
      target.aiAvoidTargets.clear();
      this.events.push({ type: "recruited", botId: target.id, byBotId: reviver.id, fromSquadId: from, squadId: reviver.squadId });
    }
    target.pleaded = false;
    target.state = "alive";
    // Back on its feet, and closed back up: whatever is left is its own again.
    target.searched = false;
    /**
     * Back on its feet with ONE WHOLE PLATE, where it used to be one cracked half.
     *
     * The intent was always "up, but fragile", and one of three still says that. The half was
     * the last surviving user of a state the rest of the game had already lost: hits break a
     * whole plate or reach the core, so a fraction could be created here and by nothing else,
     * and `shields.ts` documented three states while two were real.
     *
     * `shieldInvulnerabilityMs` covers standing up, so the fragility does not need to be
     * finer-grained than a plate.
     */
    target.shieldSegments = platesForCount(target.maxShields, 1);
    target.shields = plateSum(target.shieldSegments);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    const nudge = scale(length(reviver.lastAim) > 0 ? reviver.lastAim : { x: 1, y: 0 }, this.config.botRadius * 2.4);
    const revivedPosition = resolveAgainstSolids(
      add(target.position, nudge),
      target.radius,
      this.solidsForFloor(target.floorId),
    );
    this.placeBot(target, revivedPosition);
    this.events.push({ type: "revived", botId: target.id, byBotId: reviver.id });
  }

  /**
   * Open a body up. Nothing moves: the channel buys sight of what is there, and
   * every item after that is a deliberate take.
   *
   * This used to strip the body in one go and spill whatever would not fit onto
   * the floor — which meant the looter's own inventory decided what got thrown
   * away, sight unseen. A searched body holds what it holds until someone chooses.
   */
  private searchBody(target: InternalBot, searcher: InternalBot): void {
    target.searched = true;
    this.events.push({ type: "searched", botId: target.id, byBotId: searcher.id });
  }

  /**
   * Move one item — or everything that fits — off an open body.
   *
   * Every field here arrives from a client, so nothing is trusted: the body has to
   * exist, be open, be a rival's, and be underfoot. A take that does not fit is
   * refused rather than spilled, because the taker chose that slot.
   */
  private takeFromBody(taker: InternalBot, command: TakeCommand): Item[] {
    const body = this.bots.get(command.fromBotId);
    if (!body || !canTakeFromBody(taker, body, this.config.coverCenterTolerance)) return [];

    // Room is checked before the item leaves the body, never after: a take that
    // has to be undone is a take that can lose the item somewhere in between.
    const taken: Item[] = [];
    if (command.index === "all") {
      // Front of the body's list first, so "take all" and the picker's own order
      // agree about which items a full inventory leaves behind.
      while (carriedCount(body) > 0 && hasRoom(taker, this.config.holdSlots)) {
        const item = removeCarriedAt(body, 0);
        if (!item) break;
        insertItem(taker, item, this.config.holdSlots);
        taken.push(item);
      }
    } else {
      if (!hasRoom(taker, this.config.holdSlots)) return [];
      const item = removeCarriedAt(body, command.index);
      if (!item) return [];
      insertItem(taker, item, this.config.holdSlots);
      taken.push(item);
    }

    if (taken.length > 0) {
      this.events.push({ type: "looted", botId: body.id, byBotId: taker.id, items: taken });
    }
    return taken;
  }

  private nextRandom(): number {
    this.rngState = (1664525 * this.rngState + 1013904223) % 4294967296;
    return this.rngState / 4294967296;
  }
}

function areFriendly(a: Pick<DotBotEntity, "squadId">, b: Pick<DotBotEntity, "squadId">): boolean {
  return a.squadId === b.squadId;
}

/**
 * Does this index name a slot the bot actually has?
 *
 * Every index a client sends has to pass through here. The old guard was
 * `index < slots.length`, which admits a negative and a fraction, and neither one
 * fails loudly: `bays[-1] = item` sets a string key rather than a slot, and
 * `hold.splice(-1, 1)` counts from the end and removes the *last* held item — so a
 * client could destroy one of its own items by asking to swap into bay -1.
 */
function isSlot(slots: unknown[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < slots.length;
}

function toBotSnapshot(bot: InternalBot): DotBotEntity {
  return {
    id: bot.id,
    name: bot.name,
    squadId: bot.squadId,
    isAmbient: bot.isAmbient,
    color: bot.color,
    position: { ...bot.position },
    radius: bot.radius,
    state: bot.state,
    floorId: bot.floorId,
    facing: bot.facing,
    // The same threshold `resolveBotSeparation` splits responsibility on, so the
    // predictor is reading the server's own answer rather than re-deriving one.
    moving: length(bot.velocity) > MOVING_SPEED,
    maxShields: bot.maxShields,
    shields: bot.shields,
    shieldSegments: [...bot.shieldSegments],
    bays: bot.bays.map((item) => item && { ...item }),
    hold: bot.hold.map((item) => ({ ...item })),
    carriedCount: carriedCount(bot),
    searched: bot.searched,
    pleaded: bot.pleaded,
    radarActiveMs: bot.radarActiveMs,
    radarPings: bot.radarPings.map((ping) => ({ ...ping })),
    dashOverchargeCharges: bot.dashOverchargeCharges,
    incognitoMs: bot.incognitoMs,
    dashCooldownMs: bot.dashCooldownMs,
    dashActiveMs: bot.dashActiveMs,
    invulnerabilityMs: bot.invulnerabilityMs,
  };
}

function normalizedBays(spawn: BotSpawn, config: GameConfig): (import("./types").Item | null)[] {
  if (spawn.isAmbient) return Array.from({ length: config.baySlots }, () => null);
  const provided = spawn.bays?.slice(0, config.baySlots) ?? [{ kind: "powerup", type: "health" } as const];
  return [...provided, ...Array.from({ length: config.baySlots - provided.length }, () => null)];
}

function rectContainsPoint(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function makeAiTarget(
  position: Vec2,
  floorId: string,
  stopDistance: number,
  slowDistance: number,
  intent: AiIntent,
  targetId?: string,
): AiTarget {
  return {
    position: { ...position },
    floorId,
    stopDistance,
    slowDistance: Math.max(slowDistance, stopDistance + 1),
    intent,
    projectionAllowed: intent === "loot" || intent === "revive" || intent === "strip",
    targetId,
  };
}

/**
 * Is this leg of the path finished?
 *
 * Proximity alone was the whole rule, at `radius * 0.8` = 19.20, and 19.20 is
 * exactly the smallest centre distance any two bodies can reach (bare core
 * against bare core) — and 19.20 is not < 19.20. Every other pairing is worse:
 * 33.60 with one plate between them, 48.00 with two. So a bot could NEVER retire
 * a waypoint another bot was standing on, and `findNavigationPath` plans on
 * static geometry only, so the repath handed back the identical blocked
 * waypoint. Measured: a mover stalled 24.000 px short of its waypoint, pressing
 * 1.0 px/tick for 900 ticks against a bot that never moved, and never retired.
 *
 * Progress along the leg is the honest test. Once the bot is past the plane
 * through the waypoint perpendicular to the leg it walked, that leg is done
 * however far to the side it ended up. Proximity stays as the OR: it is the right
 * answer for the last leg and for a tight corner the bot rounds early.
 */
export function waypointRetired(position: Vec2, legStart: Vec2, waypoint: Vec2, retireRadius: number): boolean {
  if (distance(position, waypoint) < retireRadius) {
    return true;
  }
  const leg = subtract(waypoint, legStart);
  const legLengthSquared = leg.x * leg.x + leg.y * leg.y;
  if (legLengthSquared < 0.000001) {
    return true;
  }
  const travelled = subtract(position, legStart);
  return travelled.x * leg.x + travelled.y * leg.y >= legLengthSquared;
}

function steerToward(position: Vec2, target: AiTarget): Vec2 {
  const offset = subtract(target.position, position);
  const targetDistance = length(offset);

  if (targetDistance <= target.stopDistance) {
    return zeroVec();
  }

  const speedScale = clamp((targetDistance - target.stopDistance) / (target.slowDistance - target.stopDistance), 0, 1);
  return scale(normalize(offset), speedScale);
}
