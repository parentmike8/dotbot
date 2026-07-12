import type RAPIER from "@dimforge/rapier2d-compat";
import { separateCircleFromRect } from "./collision";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import {
  buildingContaining,
  classifyNoise,
  collisionLayers,
  contextKey,
  floorHeight,
  floorPlanById,
  isGroundFloor,
  isSolidObject,
  physicsFloorId,
  resolvePlan,
  stairConnections,
  stairExitPoint,
  stairHalves,
} from "./mapModel";
import { add, clamp, distance, length, normalize, normalizeInputVector, scale, subtract, zeroVec } from "./math";
import { findNavigationPath, prewarmNavigation } from "./navigation";
import { applyShieldHit, platesForCount, plateSum } from "./shields";
import { loadRapier } from "./rapier";
import { OUTDOOR_FLOOR_ID } from "./types";
import { hasLineOfSight } from "./visibility";
import type {
  BotSpawn,
  BotState,
  Building,
  Controller,
  CoverageKind,
  CoverageSnapshot,
  DotBotEntity,
  DotEntity,
  GameConfig,
  GameSnapshot,
  InputCommand,
  MapDocument,
  NoiseEvent,
  NoiseKind,
  Rect,
  SimEvent,
  StairLink,
  Vec2,
} from "./types";

const NOISE_TTL_MS = 900;
const CHANNEL_PING_MS = 700;

const NOISE_LOUDNESS = {
  dash: 0.8,
  impact: 1.0,
  stairs: 0.75,
  captureChannel: 0.5,
  coverChannel: 0.65,
  extractChannel: 0.7,
} as const;

type RapierApi = typeof RAPIER;
type RapierWorld = RAPIER.World;
type RapierBody = RAPIER.RigidBody;
type RapierCollider = RAPIER.Collider;

type InternalBot = DotBotEntity & {
  spawn: Vec2;
  spawnFloorId: string;
  body: RapierBody;
  collider: RapierCollider;
  desiredMove: Vec2;
  lastAim: Vec2;
  /** Position at the start of the tick, for stair midline-crossing checks. */
  prevPosition: Vec2;
  aiWanderTarget: Vec2;
  aiRetargetMs: number;
  aiPath: Vec2[];
  aiPathTarget: Vec2;
  aiPathFloorId: string;
  aiRepathMs: number;
  aiPathProjected: boolean;
  aiAvoidTargets: Map<string, number>;
  consumedRespawnMs: number;
};

type InternalDot = DotEntity;

type ActiveCoverage = CoverageSnapshot;

type AiIntent = "loot" | "hunt" | "revive" | "consume" | "extract" | "investigate" | "escort" | "wander";

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

  private readonly rapier: RapierApi;
  private readonly world: RapierWorld;
  private readonly bots = new Map<string, InternalBot>();
  private readonly controllers = new Map<string, Controller>();
  private readonly inputs = new Map<string, InputCommand>();
  private readonly dots = new Map<string, InternalDot>();
  private readonly coverages = new Map<string, ActiveCoverage>();
  /** Physics layer index per floor id (GROUND floors resolve to the outdoor layer). */
  private readonly layers: Map<string, number>;
  /** Static collision rects per physics floor, for the penetration safety net. */
  private readonly solidRects = new Map<string, Rect[]>();
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

  private constructor(rapier: RapierApi, map: MapDocument, config: GameConfig) {
    this.rapier = rapier;
    this.map = map;
    this.config = config;
    this.layers = collisionLayers(map);
    this.world = new this.rapier.World({ x: 0, y: 0 });
    this.world.timestep = 1 / config.tickHz;
    this.world.lengthUnit = config.botRadius;

    this.buildStaticCollision();
    this.collectStairs();

    for (const spawn of map.botSpawns) {
      this.spawnBot(spawn, spawn.controller ?? "ai");
    }

    this.spawnDots();
  }

  static async create(options: SimulationOptions = {}): Promise<DotBotSimulation> {
    const rapier = await loadRapier();
    const config = { ...defaultGameConfig, ...options.config };
    const map = options.map ?? downtownMap;

    // Navigation graph construction is intentionally paid during the async
    // loading boundary, never in the first live AI tick.
    prewarmNavigation(map, config.botRadius);

    return new DotBotSimulation(rapier, map, config);
  }

  // ---------------------------------------------------------------------------
  // World construction
  // ---------------------------------------------------------------------------

  private interactionGroups(floorId: string): number {
    const layer = this.layers.get(physicsFloorId(this.map, floorId)) ?? 0;
    const bit = 1 << layer;
    return (bit << 16) | bit;
  }

  private addStaticRect(floorId: string, rect: Rect): void {
    const body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.fixed().setTranslation(rect.x + rect.w / 2, rect.y + rect.h / 2),
    );
    this.world
      .createCollider(this.rapier.ColliderDesc.cuboid(rect.w / 2, rect.h / 2), body)
      .setCollisionGroups(this.interactionGroups(floorId));

    const rects = this.solidRects.get(physicsFloorId(this.map, floorId)) ?? [];
    rects.push(rect);
    this.solidRects.set(physicsFloorId(this.map, floorId), rects);
  }

  private buildStaticCollision(): void {
    for (const wall of this.map.outdoor.walls) {
      this.addStaticRect(OUTDOOR_FLOOR_ID, wall);
    }

    for (const object of this.map.outdoor.objects) {
      if (isSolidObject(object)) {
        this.addStaticRect(OUTDOOR_FLOOR_ID, object);
      }
    }

    for (const building of this.map.buildings) {
      for (const floor of building.floors) {
        for (const wall of floor.walls) {
          this.addStaticRect(floor.id, wall);
        }

        for (const object of floor.objects) {
          if (isSolidObject(object)) {
            this.addStaticRect(floor.id, object);
          }
        }
      }
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

  private spawnDots(): void {
    const register = (floorId: string, spawns: typeof this.map.outdoor.dotSpawns) => {
      for (const spawn of spawns) {
        this.dots.set(spawn.id, {
          id: spawn.id,
          position: { ...spawn.position },
          radius: spawn.radius ?? this.config.dotRadius,
          color: spawn.color,
          floorId,
          active: true,
          captureProgressMs: 0,
        });
      }
    };

    register(OUTDOOR_FLOOR_ID, this.map.outdoor.dotSpawns);

    for (const building of this.map.buildings) {
      for (const floor of building.floors) {
        register(physicsFloorId(this.map, floor.id), floor.dotSpawns);
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
    const body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.position.x, spawn.position.y)
        .setLinearDamping(4)
        .setAngularDamping(12)
        .setCcdEnabled(true)
        .setCanSleep(false)
        .lockRotations(),
    );

    const collider = this.world.createCollider(
      this.rapier.ColliderDesc.ball(this.config.botRadius).setRestitution(0.14).setFriction(0.22).setDensity(1),
      body,
    );
    collider.setCollisionGroups(this.interactionGroups(floorId));

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
      inventoryDots: spawn.inventoryDots ?? 0,
      dashCooldownMs: 0,
      dashActiveMs: 0,
      invulnerabilityMs: 0,
      spawn: { ...spawn.position },
      spawnFloorId: floorId,
      body,
      collider,
      desiredMove: zeroVec(),
      lastAim: { x: 1, y: 0 },
      prevPosition: { ...spawn.position },
      aiWanderTarget: { ...spawn.position },
      aiRetargetMs: 0,
      aiPath: [],
      aiPathTarget: { ...spawn.position },
      aiPathFloorId: floorId,
      aiRepathMs: 0,
      aiPathProjected: false,
      aiAvoidTargets: new Map(),
      consumedRespawnMs: 0,
    };

    this.setBotPhysicsState(bot, state);
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
    });
  }

  setController(botId: string, controller: Controller): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }

    this.controllers.set(botId, controller);
    if (controller === "frozen") {
      bot.desiredMove = zeroVec();
      bot.body.setLinvel(zeroVec(), true);
    }
  }

  removeBot(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot) {
      return;
    }

    this.world.removeCollider(bot.collider, true);
    this.world.removeRigidBody(bot.body);
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

    for (const bot of this.bots.values()) {
      bot.prevPosition = { ...bot.position };
    }

    this.updateHumanIntents();
    this.updateBotAi();
    this.applyMovement();

    this.world.step();
    this.resolveWallPenetration();
    this.syncPhysicsPositions();
    this.resolveStairs();
    this.resolveCombat();
    this.resolveDotCapture(dtMs);
    this.resolveDownedCoverage(dtMs);
    this.resolveExtraction(dtMs);
    this.respawnConsumedBots(dtMs);
  }

  getSnapshot(): GameSnapshot {
    const bots = [...this.bots.values()].map(toBotSnapshot);
    const dots = [...this.dots.values()].map((dot) => ({ ...dot, position: { ...dot.position } }));

    return {
      timeMs: this.timeMs,
      bots,
      dots,
      coverages: [...this.coverages.values()].map((coverage) => ({ ...coverage })),
      noises: this.noises.map((noise) => ({ ...noise, position: { ...noise.position } })),
      debug: {
        tickHz: this.config.tickHz,
        tickCount: this.tickCount,
        fps: this.fps,
        activeBodies: bots.filter((bot) => bot.state !== "consumed").length,
        activeDots: dots.filter((dot) => dot.active).length,
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    try {
      this.world.free();
    } catch {
      // React Fast Refresh can tear down a WASM world that has already been
      // released. Cleanup must remain safe and idempotent.
    }
  }

  // ---------------------------------------------------------------------------
  // Per-tick systems
  // ---------------------------------------------------------------------------

  private emitNoise(kind: NoiseKind, position: Vec2, floorId: string, loudness: number): void {
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

  /** True once per CHANNEL_PING_MS while a channel's progress accumulates. */
  private channelPingDue(progressMs: number, dtMs: number): boolean {
    return Math.floor(progressMs / CHANNEL_PING_MS) > Math.floor((progressMs - dtMs) / CHANNEL_PING_MS);
  }

  private updateTimers(dtMs: number): void {
    for (const bot of this.bots.values()) {
      bot.dashCooldownMs = Math.max(0, bot.dashCooldownMs - dtMs);
      bot.dashActiveMs = Math.max(0, bot.dashActiveMs - dtMs);
      bot.invulnerabilityMs = Math.max(0, bot.invulnerabilityMs - dtMs);
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
  }

  private updateHumanIntents(): void {
    for (const bot of this.bots.values()) {
      const controller = this.controllers.get(bot.id);
      if (controller === "frozen") {
        bot.desiredMove = zeroVec();
        continue;
      }
      if (controller !== "human" || bot.state !== "alive") {
        continue;
      }

      const input = this.inputs.get(bot.id) ?? { move: zeroVec(), dash: false };
      bot.desiredMove = input.move;

      if (length(input.move) > 0.05) {
        bot.lastAim = input.move;
      }

      if (input.dash) {
        if (bot.dashCooldownMs <= 0 && bot.dashActiveMs <= 0) {
          bot.dashActiveMs = this.config.dashDurationMs;
          bot.dashCooldownMs = this.config.dashCooldownMs;
          this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash);
        }

        // A press is consumed on the tick it is considered, fired or not.
        // Pressing during cooldown must never bank a dash for later.
        this.inputs.set(bot.id, { ...input, dash: false });
      }
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

    const shouldFlee = bot.inventoryDots > 0 && bot.shields <= 1;
    const inventoryFull = bot.inventoryDots >= this.config.maxInventoryDots;

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
      return makeAiTarget(hostileDowned.position, hostileDowned.floorId, bot.radius * 0.42, bot.radius * 3, "consume", hostileDowned.id);
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
          hasLineOfSight(this.map, contextKey(this.map, bot.floorId, bot.position), bot.position, target.position),
      ),
    );

    if (visibleHostile) {
      return makeAiTarget(visibleHostile.position, visibleHostile.floorId, bot.radius * 1.85, bot.radius * 4.5, "hunt", visibleHostile.id);
    }

    const dot = rank(
      [...this.dots.values()].filter(
        (candidate) => candidate.active && bot.inventoryDots < this.config.maxInventoryDots && localOrVertical(candidate) && available(candidate),
      ),
    );

    if (dot && this.strategicDistance(bot, dot) < 820) {
      return makeAiTarget(dot.position, dot.floorId, Math.max(2, bot.radius - dot.radius - 4), bot.radius * 3.2, "loot", dot.id);
    }

    if (!bot.isAmbient && bot.inventoryDots >= Math.max(2, this.config.maxInventoryDots - 2)) {
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
        : target.intent === "revive" || target.intent === "consume"
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
      !hasLineOfSight(this.map, contextKey(this.map, bot.floorId, bot.position), bot.position, hostile.position)
    ) {
      return;
    }

    bot.lastAim = normalize(desired);
    bot.dashActiveMs = this.config.dashDurationMs;
    bot.dashCooldownMs = this.config.dashCooldownMs + 250 + this.nextRandom() * 450;
    this.emitNoise("dash", bot.position, bot.floorId, NOISE_LOUDNESS.dash);
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

  private applyMovement(): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive") {
        bot.body.setLinvel(zeroVec(), true);
        continue;
      }

      if (this.controllers.get(bot.id) === "frozen") {
        bot.body.setLinvel(zeroVec(), true);
        continue;
      }

      const speed =
        bot.dashActiveMs > 0
          ? this.config.dashSpeed
          : this.controllers.get(bot.id) === "human"
            ? this.config.playerSpeed
            : this.config.botSpeed;
      const direction = bot.dashActiveMs > 0 ? bot.lastAim : bot.desiredMove;
      bot.body.setLinvel(scale(direction, speed), true);

      // Shield plates follow the direction of travel.
      if (length(direction) > 0.05) {
        bot.facing = Math.atan2(direction.y, direction.x);
      }
    }
  }

  private syncPhysicsPositions(): void {
    for (const bot of this.bots.values()) {
      if (bot.state === "consumed") {
        continue;
      }

      const translation = bot.body.translation();
      bot.position = {
        x: clamp(translation.x, this.config.botRadius, this.map.width - this.config.botRadius),
        y: clamp(translation.y, this.config.botRadius, this.map.height - this.config.botRadius),
      };
    }
  }

  private resolveWallPenetration(): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive") {
        continue;
      }

      const rects = this.solidRects.get(bot.floorId) ?? [];
      let position = bot.body.translation();

      for (let iteration = 0; iteration < 3; iteration += 1) {
        let moved = false;

        for (const rect of rects) {
          const next = separateCircleFromRect(position, bot.radius, rect);

          if (next.x !== position.x || next.y !== position.y) {
            position = next;
            moved = true;
          }
        }

        if (!moved) {
          break;
        }
      }

      const clampedPosition = {
        x: clamp(position.x, bot.radius, this.map.width - bot.radius),
        y: clamp(position.y, bot.radius, this.map.height - bot.radius),
      };

      if (clampedPosition.x !== bot.body.translation().x || clampedPosition.y !== bot.body.translation().y) {
        bot.body.setTranslation(clampedPosition, true);
        bot.body.setLinvel(zeroVec(), true);
      }
    }
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
        bot.collider.setCollisionGroups(this.interactionGroups(targetFloor));
        bot.aiPath = [];
        bot.aiRepathMs = 0;
        bot.aiPathProjected = false;

        // Stairs announce themselves on both connected floors.
        this.emitNoise("stairs", bot.position, sourceFloor, NOISE_LOUDNESS.stairs);
        this.emitNoise("stairs", bot.position, targetFloor, NOISE_LOUDNESS.stairs);
        break;
      }
    }
  }

  private resolveCombat(): void {
    const aliveBots = [...this.bots.values()].filter((bot) => bot.state === "alive");

    for (let i = 0; i < aliveBots.length; i += 1) {
      for (let j = i + 1; j < aliveBots.length; j += 1) {
        const a = aliveBots[i];
        const b = aliveBots[j];

        if (a.floorId !== b.floorId) {
          continue;
        }

        // No friendly fire: squadmates bump, never wound each other.
        if (areFriendly(a, b)) {
          continue;
        }

        const gap = distance(a.position, b.position) - a.radius - b.radius;

        if (gap > 4) {
          continue;
        }

        const aSpeed = length(a.body.linvel());
        const bSpeed = length(b.body.linvel());
        const aDashing = a.dashActiveMs > 0;
        const bDashing = b.dashActiveMs > 0;

        if (!aDashing && !bDashing && Math.max(aSpeed, bSpeed) < this.config.damageSpeed) {
          continue;
        }

        if (aDashing && !bDashing) {
          this.damageBot(b, a);
        } else if (bDashing && !aDashing) {
          this.damageBot(a, b);
        } else if (aSpeed > bSpeed + 20) {
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

  private damageBot(target: InternalBot, source: InternalBot): void {
    if (target.id === source.id || target.state !== "alive" || target.invulnerabilityMs > 0) {
      return;
    }

    // A hit on a live plate shatters it; a hit on bare body cracks the
    // nearest surviving plate by half (see shields.ts for the model).
    const impactAngle = Math.atan2(source.position.y - target.position.y, source.position.x - target.position.x);
    applyShieldHit(target.facing, target.shieldSegments, impactAngle);
    target.shields = plateSum(target.shieldSegments);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    this.emitNoise("impact", target.position, target.floorId, NOISE_LOUDNESS.impact);

    if (target.shields <= 0) {
      target.state = "downed";
      target.dashActiveMs = 0;
      target.body.setLinvel(zeroVec(), true);
      this.setBotPhysicsState(target, "downed");
      this.events.push({ type: "downed", botId: target.id, byBotId: source.id });
    }
  }

  private resolveDotCapture(dtMs: number): void {
    const aliveBots = [...this.bots.values()].filter((bot) => bot.state === "alive");

    for (const dot of this.dots.values()) {
      if (!dot.active) {
        continue;
      }

      const coveringBot = aliveBots.find(
        (bot) =>
          bot.floorId === dot.floorId &&
          bot.inventoryDots < this.config.maxInventoryDots &&
          distance(bot.position, dot.position) + dot.radius <= bot.radius - 2,
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
        this.emitNoise("channel", dot.position, dot.floorId, NOISE_LOUDNESS.captureChannel);
      }

      this.coverages.set(`capture:${dot.id}`, {
        kind: "capture",
        actorId: coveringBot.id,
        targetId: dot.id,
        progressMs: dot.captureProgressMs,
        durationMs: this.config.dotCaptureDurationMs,
      });

      if (dot.captureProgressMs >= this.config.dotCaptureDurationMs) {
        dot.active = false;
        coveringBot.inventoryDots = Math.min(this.config.maxInventoryDots, coveringBot.inventoryDots + 1);
        this.events.push({ type: "dotCaptured", botId: coveringBot.id, dotId: dot.id });
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
    const aliveBots = [...this.bots.values()].filter((bot) => bot.state === "alive");
    const downedBots = [...this.bots.values()].filter((bot) => bot.state === "downed");

    for (const downed of downedBots) {
      const coveringBot = aliveBots.find(
        (bot) =>
          bot.id !== downed.id &&
          bot.floorId === downed.floorId &&
          canCoverDownedBot(bot, downed, this.config.coverCenterTolerance),
      );
      const coverageKey = `downed:${downed.id}`;

      if (!coveringBot) {
        this.coverages.delete(coverageKey);
        continue;
      }

      const kind: CoverageKind = areFriendly(coveringBot, downed) ? "revive" : "consume";

      const existing = this.coverages.get(coverageKey);
      const progressMs = existing?.actorId === coveringBot.id && existing.kind === kind ? existing.progressMs + dtMs : dtMs;

      if (this.channelPingDue(progressMs, dtMs)) {
        this.emitNoise("channel", downed.position, downed.floorId, NOISE_LOUDNESS.coverChannel);
      }

      this.coverages.set(coverageKey, {
        kind,
        actorId: coveringBot.id,
        targetId: downed.id,
        progressMs,
        durationMs: this.config.coverDurationMs,
      });

      if (progressMs >= this.config.coverDurationMs) {
        if (kind === "revive") {
          this.reviveBot(downed, coveringBot);
        } else {
          this.consumeBot(downed, coveringBot);
        }

        this.coverages.delete(coverageKey);
      }
    }
  }

  private resolveExtraction(dtMs: number): void {
    const activeKeys = new Set<string>();

    for (const bot of this.bots.values()) {
      if (bot.isAmbient || bot.state !== "alive" || bot.floorId !== OUTDOOR_FLOOR_ID || bot.inventoryDots <= 0) {
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
        this.emitNoise("channel", bot.position, bot.floorId, NOISE_LOUDNESS.extractChannel);
      }

      this.coverages.set(coverageKey, {
        kind: "extract",
        actorId: bot.id,
        targetId: point.id,
        progressMs,
        durationMs: this.config.extractionDurationMs,
      });

      if (progressMs >= this.config.extractionDurationMs) {
        this.events.push({ type: "extracted", botId: bot.id, squadId: bot.squadId, inventoryDots: bot.inventoryDots });
        this.removeBot(bot.id);
      }
    }

    for (const [key, coverage] of this.coverages) {
      if (coverage.kind === "extract" && !activeKeys.has(key)) {
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
    const revivedPosition = add(target.position, nudge);
    target.body.setTranslation(
      {
        x: clamp(revivedPosition.x, this.config.botRadius, this.map.width - this.config.botRadius),
        y: clamp(revivedPosition.y, this.config.botRadius, this.map.height - this.config.botRadius),
      },
      true,
    );
    target.body.setLinvel(zeroVec(), true);
    this.setBotPhysicsState(target, "alive");
    this.events.push({ type: "revived", botId: target.id, byBotId: reviver.id });
  }

  private consumeBot(target: InternalBot, consumer: InternalBot): void {
    const lostDots = target.inventoryDots;
    const loot = Math.min(this.config.maxInventoryDots - consumer.inventoryDots, target.inventoryDots);
    consumer.inventoryDots += Math.max(0, loot);
    target.state = "consumed";
    target.shieldSegments = platesForCount(target.maxShields, 0);
    target.shields = 0;
    target.inventoryDots = 0;
    target.consumedRespawnMs = this.config.respawnDelayMs;
    this.setBotPhysicsState(target, "consumed");
    this.events.push({ type: "consumed", botId: target.id, byBotId: consumer.id, lostDots });
  }

  private respawnConsumedBots(dtMs: number): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "consumed" || !bot.isAmbient) {
        continue;
      }

      bot.consumedRespawnMs -= dtMs;

      if (bot.consumedRespawnMs > 0) {
        continue;
      }

      bot.state = "alive";
      bot.shieldSegments = platesForCount(bot.maxShields, bot.maxShields);
      bot.shields = plateSum(bot.shieldSegments);
      bot.inventoryDots = bot.isAmbient ? 0 : 1;
      bot.dashActiveMs = 0;
      bot.dashCooldownMs = 0;
      bot.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
      bot.floorId = bot.spawnFloorId;
      bot.position = { ...bot.spawn };
      bot.prevPosition = { ...bot.spawn };
      bot.aiPath = [];
      bot.aiPathTarget = { ...bot.spawn };
      bot.aiPathFloorId = bot.spawnFloorId;
      bot.aiRepathMs = 0;
      bot.aiPathProjected = false;
      bot.aiAvoidTargets.clear();
      bot.aiRetargetMs = 0;
      bot.body.setEnabled(true);
      bot.collider.setEnabled(true);
      bot.collider.setCollisionGroups(this.interactionGroups(bot.spawnFloorId));
      bot.body.setTranslation(bot.spawn, true);
      bot.body.setLinvel(zeroVec(), true);
      this.setBotPhysicsState(bot, "alive");
    }
  }

  private setBotPhysicsState(bot: InternalBot, state: BotState): void {
    if (state === "alive") {
      bot.body.setEnabled(true);
      bot.collider.setEnabled(true);
      bot.collider.setSensor(false);
      return;
    }

    if (state === "downed") {
      bot.body.setEnabled(true);
      bot.collider.setSensor(true);
      bot.collider.setEnabled(false);
      return;
    }

    bot.body.setEnabled(false);
    bot.collider.setEnabled(false);
  }

  private nextRandom(): number {
    this.rngState = (1664525 * this.rngState + 1013904223) % 4294967296;
    return this.rngState / 4294967296;
  }
}

function areFriendly(a: Pick<DotBotEntity, "squadId">, b: Pick<DotBotEntity, "squadId">): boolean {
  return a.squadId === b.squadId;
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
    inventoryDots: bot.inventoryDots,
    dashCooldownMs: bot.dashCooldownMs,
    dashActiveMs: bot.dashActiveMs,
    invulnerabilityMs: bot.invulnerabilityMs,
  };
}

function rectContainsPoint(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function canCoverDownedBot(actor: InternalBot, target: InternalBot, minimumTolerance: number): boolean {
  const downedFootprintRadius = target.radius * 0.55;
  return distance(actor.position, target.position) <= Math.max(minimumTolerance, actor.radius + downedFootprintRadius);
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
    projectionAllowed: intent === "loot" || intent === "revive" || intent === "consume",
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
