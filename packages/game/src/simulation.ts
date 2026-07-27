import { collectSolids, separateCircleFromRect } from "./collision";
import { buildSolidIndex, withExtraSolids, type SolidIndex, type SolidSource } from "./solidIndex";
import { rectSolid } from "./geometry";
import { integrateWithWalls, pointSegmentDistance, resolveAgainstSolids, separationPush } from "./kinematics";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import {
  buildingContaining,
  classifyNoise,
  collisionLayers,
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
import { interactionDotReach, withinDownedCoverRange, withinInteractionDotRange } from "./interactions";
import { add, clamp, distance, length, normalize, normalizeInputVector, scale, subtract, zeroVec } from "./math";
import { findNavigationPath, prewarmNavigation } from "./navigation";
import { carriedCount, carriedItems, insertItem } from "./inventory";
import { applyShieldHit, platesForCount, plateSum, restoreShieldPlate, shatterNearestIntactPlate } from "./shields";
import { OUTDOOR_FLOOR_ID } from "./types";
import { hasLineOfSight } from "./visibility";
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
  Vec2,
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

const NOISE_LOUDNESS = {
  dash: 0.8,
  impact: 1.0,
  stairs: 0.75,
  captureChannel: 0.5,
  coverChannel: 0.65,
  extractChannel: 0.7,
  mineDetonation: 1.0,
} as const;

type InternalBot = DotBotEntity & {
  spawn: Vec2;
  spawnFloorId: string;
  desiredMove: Vec2;
  lastAim: Vec2;
  /** Velocity applied this tick (movement + knockback); combat reads this. */
  velocity: Vec2;
  knockbackVel: Vec2;
  knockbackMs: number;
  /** Position at the start of the tick, for stair midline-crossing checks. */
  prevPosition: Vec2;
  /** Recent end-of-tick positions (newest last) for combat lag compensation. */
  positionHistory: Array<{ position: Vec2; floorId: string }>;
  /** How many ticks in the past this bot perceives the world (render delay). */
  viewDelayTicks: number;
  aiWanderTarget: Vec2;
  aiRetargetMs: number;
  aiPath: Vec2[];
  aiPathTarget: Vec2;
  aiPathFloorId: string;
  aiRepathMs: number;
  aiPathProjected: boolean;
  aiAvoidTargets: Map<string, number>;
  pleaCooldownMs: number;
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
  private noises: NoiseEvent[] = [];
  private noiseSeq = 0;
  private spillSeq = 0;
  private mineSeq = 0;

  private constructor(map: MapDocument, config: GameConfig) {
    this.map = map;
    this.config = config;
    // Rejects a map with more physics layers than the floor model allows,
    // before any of it is built.
    collisionLayers(map);

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
      maxShields,
      shields: plateSum(shieldSegments),
      shieldSegments,
      bays: normalizedBays(spawn, this.config),
      hold: spawn.isAmbient ? [] : (spawn.hold ?? []).slice(0, this.config.holdSlots),
      carriedCount: 0,
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
      knockbackVel: zeroVec(),
      knockbackMs: 0,
      prevPosition: { ...spawn.position },
      positionHistory: [],
      viewDelayTicks: 0,
      aiWanderTarget: { ...spawn.position },
      aiRetargetMs: 0,
      aiPath: [],
      aiPathTarget: { ...spawn.position },
      aiPathFloorId: floorId,
      aiRepathMs: 0,
      aiPathProjected: false,
      aiAvoidTargets: new Map(),
      pleaCooldownMs: 0,
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
      plea: (current?.plea ?? false) || input.plea,
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
          bot.pleaCooldownMs = this.config.pleaCooldownMs;
          this.events.push({ type: "plea", botId: bot.id, squadId: bot.squadId, position: { ...bot.position }, floorId: bot.floorId });
        }
        if (input?.dash || input?.useBay !== undefined || input?.swapBay || input?.plea) {
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

      if (input.dash && !bot.activeSwap) {
        const overcharged = bot.dashOverchargeCharges > 0;
        if ((overcharged || bot.dashCooldownMs <= 0) && bot.dashActiveMs <= 0) {
          bot.dashActiveMs = this.config.dashDurationMs;
          if (overcharged) bot.dashOverchargeCharges -= 1;
          else bot.dashCooldownMs = this.config.dashCooldownMs;
          this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash, bot);
        }

        // A press is consumed on the tick it is considered, fired or not.
        // Pressing during cooldown must never bank a dash for later.
      }
      if (input.dash || input.useBay !== undefined || input.swapBay || input.plea) {
        this.inputs.set(bot.id, { ...input, dash: false, useBay: undefined, swapBay: undefined, plea: false });
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
    const impactAngle = Math.atan2(mine.position.y - target.position.y, mine.position.x - target.position.x);
    const shattered = shatterNearestIntactPlate(target.facing, target.shieldSegments, impactAngle);
    target.shields = plateSum(target.shieldSegments);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    this.emitNoise("mineDetonation", mine.position, mine.floorId, NOISE_LOUDNESS.mineDetonation);

    if (shattered === null || target.shields <= 0) {
      target.shieldSegments = platesForCount(target.maxShields, 0);
      target.shields = 0;
      target.state = "downed";
      target.dashActiveMs = 0;
      target.velocity = zeroVec();
      target.knockbackMs = 0;
      this.events.push({ type: "downed", botId: target.id, byBotId: mine.placedByBotId });
    }
  }

  private updateBotAi(): void {
    for (const bot of this.bots.values()) {
      if (this.controllers.get(bot.id) !== "ai" || bot.state !== "alive") {
        continue;
      }

      const objective = this.pickBotTarget(bot);
      const routedTarget = this.routeAiTarget(bot, objective);
      const desired = this.steerBotAlongPath(bot, routedTarget);
      bot.desiredMove = desired;

      if (length(desired) > 0.05) {
        bot.lastAim = desired;
      }

      this.tryAiDash(bot, objective, desired);
    }
  }

  private sameArena(bot: InternalBot, floorId: string, position: Vec2): boolean {
    return contextKey(this.map, bot.floorId, bot.position) === contextKey(this.map, floorId, position);
  }

  private pickBotTarget(bot: InternalBot): AiTarget {
    if (bot.isAmbient) return this.pickAmbientTarget(bot);
    const sameBuilding = (target: { floorId: string; position: Vec2 }) => {
      const botPlan = resolvePlan(this.map, bot.floorId, bot.position);
      const targetPlan = resolvePlan(this.map, target.floorId, target.position);
      return botPlan !== null && targetPlan !== null && botPlan.buildingId === targetPlan.buildingId;
    };
    const localOrVertical = (target: { floorId: string; position: Vec2 }) => this.sameArena(bot, target.floorId, target.position) || sameBuilding(target);
    const available = (target: { id: string }) => !bot.aiAvoidTargets.has(target.id);
    const rank = <T extends { floorId: string; position: Vec2 }>(values: T[]) =>
      values.sort((a, b) => this.strategicDistance(bot, a) - this.strategicDistance(bot, b))[0];

    const friendlyDowned = rank(
      [...this.bots.values()].filter(
        (target) => target.id !== bot.id && target.state === "downed" && areFriendly(bot, target) && localOrVertical(target) && available(target),
      ),
    );

    if (friendlyDowned && this.strategicDistance(bot, friendlyDowned) < 760) {
      return makeAiTarget(friendlyDowned.position, friendlyDowned.floorId, bot.radius * 0.42, bot.radius * 3, "revive", friendlyDowned.id);
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
        (target) => target.id !== bot.id && target.state === "downed" && !areFriendly(bot, target) && localOrVertical(target) && available(target),
      ),
    );

    if (hostileDowned && this.strategicDistance(bot, hostileDowned) < 760) {
      return makeAiTarget(hostileDowned.position, hostileDowned.floorId, bot.radius * 0.42, bot.radius * 3, "strip", hostileDowned.id);
    }

    const visibleHostile = rank(
      [...this.bots.values()].filter(
        (target) =>
          target.id !== bot.id &&
          target.state === "alive" &&
          !areFriendly(bot, target) &&
          available(target) &&
          this.sameArena(bot, target.floorId, target.position) &&
          distance(bot.position, target.position) < 540 &&
          hasLineOfSight(
            this.map,
            contextKey(this.map, bot.floorId, bot.position),
            bot.position,
            target.position,
            this.doorOccludersForFloor(bot.floorId),
          ),
      ),
    );

    if (visibleHostile) {
      return makeAiTarget(visibleHostile.position, visibleHostile.floorId, bot.radius * 1.85, bot.radius * 4.5, "hunt", visibleHostile.id);
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
      return makeAiTarget(strategicHostile.position, strategicHostile.floorId, bot.radius * 1.85, bot.radius * 4.5, "hunt", strategicHostile.id);
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
        this.sameArena(bot, target.floorId, target.position) && distance(bot.position, target.position) < 540 &&
        hasLineOfSight(
          this.map,
          contextKey(this.map, bot.floorId, bot.position),
          bot.position,
          target.position,
          this.doorOccludersForFloor(bot.floorId),
        ))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];
    if (hostile) {
      return makeAiTarget(hostile.position, hostile.floorId, bot.radius * 1.85, bot.radius * 4.5, "hunt", hostile.id);
    }

    const heard = [...this.noises].reverse().find((noise) =>
      available(noise) && classifyNoise(this.map, bot.floorId, bot.position, noise.floorId, noise.position, noise.loudness) !== null);
    if (heard) return makeAiTarget(heard.position, heard.floorId, 34, bot.radius * 5, "investigate", heard.id);

    const strategic = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "alive" && !areFriendly(bot, target) && available(target))
      .sort((a, b) => this.strategicDistance(bot, a) - this.strategicDistance(bot, b))[0];
    if (strategic && this.strategicDistance(bot, strategic) < 900) {
      return makeAiTarget(strategic.position, strategic.floorId, bot.radius * 1.85, bot.radius * 4.5, "hunt", strategic.id);
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

  private steerBotAlongPath(bot: InternalBot, target: AiTarget): Vec2 {
    const targetChanged =
      bot.aiPathFloorId !== bot.floorId ||
      distance(bot.aiPathTarget, target.position) > (target.intent === "hunt" || target.intent === "escort" ? 64 : 20);

    if (bot.aiRepathMs <= 0 || targetChanged) {
      let path = findNavigationPath(this.map, bot.floorId, bot.position, target.position, bot.radius);
      let projected = false;

      if (path.length === 0) {
        const projectedPath = this.projectedInteractionPath(bot, target);
        path = projectedPath ?? [];
        projected = projectedPath !== null;
      }

      bot.aiPathTarget = { ...target.position };
      bot.aiPathFloorId = bot.floorId;
      bot.aiRepathMs = 700 + this.nextRandom() * 300;
      bot.aiPathProjected = projected;

      if (path.length === 0) {
        bot.aiPath = [];
        bot.aiRepathMs = 0;

        if (target.targetId) {
          bot.aiAvoidTargets.set(target.targetId, 1800 + this.nextRandom() * 1200);
        } else if (target.intent === "wander") {
          bot.aiRetargetMs = 0;
        }

        // An empty A* result is not permission to steer through geometry.
        return zeroVec();
      }

      bot.aiPath = path.length > 1 ? path.slice(1) : [];
    }

    while (bot.aiPath.length > 1 && distance(bot.position, bot.aiPath[0]) < bot.radius * 0.8) {
      bot.aiPath.shift();
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

  private tryAiDash(bot: InternalBot, target: AiTarget, desired: Vec2): void {
    if (target.intent !== "hunt" || !target.targetId || bot.dashCooldownMs > 0 || bot.dashActiveMs > 0 || length(desired) < 0.01) {
      return;
    }

    const hostile = this.bots.get(target.targetId);
    if (!hostile || hostile.state !== "alive" || !this.sameArena(bot, hostile.floorId, hostile.position)) {
      return;
    }

    const targetDistance = distance(bot.position, hostile.position);
    if (
      targetDistance < bot.radius * 1.9 ||
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

    bot.lastAim = normalize(desired);
    bot.dashActiveMs = this.config.dashDurationMs;
    bot.dashCooldownMs = this.config.dashCooldownMs + 250 + this.nextRandom() * 450;
    this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash, bot);
  }

  /** Indoor bots wander their building footprint; outdoor bots wander the map. */
  private pickWanderTarget(bot: InternalBot): Vec2 {
    const bounds =
      bot.floorId !== OUTDOOR_FLOOR_ID
        ? this.map.buildings.find((building) => building.floors.some((floor) => floor.id === bot.floorId))?.footprint
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
        const aMoving = length(a.velocity) > 5;
        const bMoving = length(b.velocity) > 5;
        const yieldA = aMoving === bMoving ? 0.5 : aMoving ? 1 : 0;
        const yieldB = aMoving === bMoving ? 0.5 : bMoving ? 1 : 0;
        const pushA = separationPush(a.position, a.radius, b.position, b.radius, maxPushPx, yieldA);
        const pushB = separationPush(b.position, b.radius, a.position, a.radius, maxPushPx, yieldB);
        if (pushA.x === 0 && pushA.y === 0 && pushB.x === 0 && pushB.y === 0) {
          continue;
        }
        const solids = this.solidsForFloor(a.floorId);
        if (pushA.x !== 0 || pushA.y !== 0) {
          this.placeBot(a, resolveAgainstSolids(add(a.position, pushA), a.radius, solids));
        }
        if (pushB.x !== 0 || pushB.y !== 0) {
          this.placeBot(b, resolveAgainstSolids(add(b.position, pushB), b.radius, solids));
        }
      }
    }
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
    return sweep - attacker.radius - victim.radius <= 4;
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
    const touching = attacker.radius + victim.radius;
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

        const aSpeed = length(a.velocity);
        const bSpeed = length(b.velocity);
        const aDashing = a.dashActiveMs > 0;
        const bDashing = b.dashActiveMs > 0;

        if (aDashing || bDashing) {
          // Dashes are the attack verb: each direction is tested against the
          // victim as the attacker saw them (lag compensated), so a dash
          // through the enemy on screen lands even though the wire is late.
          // A connecting dash STOPS at its target instead of ghosting on.
          if (aDashing && this.attackConnects(a, b) && this.damageBot(b, a)) {
            this.stopDashAtContact(a, b);
          }
          if (bDashing && this.attackConnects(b, a) && this.damageBot(a, b)) {
            this.stopDashAtContact(b, a);
          }
          continue;
        }

        if (a.floorId !== b.floorId) {
          continue;
        }

        const gap = distance(a.position, b.position) - a.radius - b.radius;
        if (gap > 4 || Math.max(aSpeed, bSpeed) < this.config.damageSpeed) {
          continue;
        }

        if (aSpeed > bSpeed + 20) {
          this.damageBot(b, a);
        } else if (bSpeed > aSpeed + 20) {
          this.damageBot(a, b);
        } else {
          this.damageBot(a, b);
          this.damageBot(b, a);
        }
      }
    }
  }

  /** Applies one hit; returns whether damage actually landed (false while
   * the target is invulnerable or already down). */
  private damageBot(target: InternalBot, source: InternalBot): boolean {
    if (target.id === source.id || target.state !== "alive" || target.invulnerabilityMs > 0) {
      return false;
    }

    // A hit on a live plate shatters it; a hit on bare body cracks the
    // nearest surviving plate by half (see shields.ts for the model).
    const impactAngle = Math.atan2(source.position.y - target.position.y, source.position.x - target.position.x);
    const shieldHit = applyShieldHit(target.facing, target.shieldSegments, impactAngle);
    target.shields = plateSum(target.shieldSegments);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    this.emitNoise("impact", target.position, target.floorId, NOISE_LOUDNESS.impact);
    const away = { x: -Math.cos(impactAngle), y: -Math.sin(impactAngle) };
    const result = target.shields <= 0 ? "downed" : shieldHit.direct ? "plateBreak" : "bodyHit";
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

    if (target.shields <= 0) {
      target.state = "downed";
      target.dashActiveMs = 0;
      target.velocity = zeroVec();
      target.knockbackMs = 0;
      this.events.push({ type: "downed", botId: target.id, byBotId: source.id });
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

    for (const downed of downedBots) {
      const coveringBot = aliveBots.find(
        (bot) =>
          bot.id !== downed.id &&
          bot.floorId === downed.floorId &&
          withinDownedCoverRange(bot.position, bot.radius, downed.position, downed.radius, this.config.coverCenterTolerance),
      );
      const coverageKey = `downed:${downed.id}`;

      if (!coveringBot) {
        this.coverages.delete(coverageKey);
        continue;
      }

      let kind: CoverageKind;
      if (areFriendly(coveringBot, downed)) {
        // A squadmate is here to pick you up. There is nothing to choose.
        kind = "revive";
      } else {
        const controller = this.controllers.get(coveringBot.id);
        // An AI standing over a body strips it and moves on. It cannot finish the
        // body off, because nothing can.
        const verb = controller === "human" ? this.inputs.get(coveringBot.id)?.downedVerb : "loot";
        if (!verb) {
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
        if (kind === "loot") this.lootBot(downed, coveringBot);
        else this.reviveBot(downed, coveringBot);

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
    target.state = "alive";
    target.shieldSegments = platesForCount(target.maxShields, 0);
    if (target.shieldSegments.length > 0) {
      target.shieldSegments[0] = 0.5;
    }
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
   * Strip a body of everything it carries. The body stays exactly where it is, in
   * the state it was in: being looted is not an ending.
   */
  private lootBot(target: InternalBot, looter: InternalBot): Item[] {
    const taken = carriedItems(target);
    const overflow = taken.filter((item) => !insertItem(looter, item, this.config.holdSlots));
    overflow.forEach((item, index) => {
      const angle = (index * Math.PI * 2) / Math.max(1, overflow.length);
      const id = `spill-${this.spillSeq++}`;
      this.dots.set(id, {
        id,
        item: { ...item },
        position: add(target.position, { x: Math.cos(angle) * 8, y: Math.sin(angle) * 8 }),
        radius: this.config.dotRadius,
        floorId: target.floorId,
        active: true,
        captureProgressMs: 0,
      });
    });
    target.bays = Array.from({ length: this.config.baySlots }, () => null);
    target.hold = [];
    this.events.push({ type: "looted", botId: target.id, byBotId: looter.id, items: taken });
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
    maxShields: bot.maxShields,
    shields: bot.shields,
    shieldSegments: [...bot.shieldSegments],
    bays: bot.bays.map((item) => item && { ...item }),
    hold: bot.hold.map((item) => ({ ...item })),
    carriedCount: carriedCount(bot),
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

function steerToward(position: Vec2, target: AiTarget): Vec2 {
  const offset = subtract(target.position, position);
  const targetDistance = length(offset);

  if (targetDistance <= target.stopDistance) {
    return zeroVec();
  }

  const speedScale = clamp((targetDistance - target.stopDistance) / (target.slowDistance - target.stopDistance), 0, 1);
  return scale(normalize(offset), speedScale);
}
