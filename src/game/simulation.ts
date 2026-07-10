import type RAPIER from "@dimforge/rapier2d-compat";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import {
  buildingContaining,
  collisionLayers,
  contextKey,
  isSolidObject,
  locationLabel,
  physicsFloorId,
  stairHalves,
} from "./mapModel";
import { add, clamp, distance, length, normalize, normalizeInputVector, scale, subtract, zeroVec } from "./math";
import { loadRapier } from "./rapier";
import { OUTDOOR_FLOOR_ID } from "./types";
import { hasLineOfSight } from "./visibility";
import type {
  BotSpawn,
  BotState,
  BotTeam,
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
  consumedRespawnMs: number;
};

type InternalDot = DotEntity;

type ActiveCoverage = CoverageSnapshot;

type AiTarget = {
  position: Vec2;
  stopDistance: number;
  slowDistance: number;
};

type SimulationOptions = {
  map?: MapDocument;
  config?: Partial<GameConfig>;
};

const FRIENDLY_TEAMS = new Set<BotTeam>(["player", "ally"]);

export class DotBotSimulation {
  readonly config: GameConfig;
  readonly map: MapDocument;

  private readonly rapier: RapierApi;
  private readonly world: RapierWorld;
  private readonly bots = new Map<string, InternalBot>();
  private readonly dots = new Map<string, InternalDot>();
  private readonly coverages = new Map<string, ActiveCoverage>();
  /** Physics layer index per floor id (GROUND floors resolve to the outdoor layer). */
  private readonly layers: Map<string, number>;
  /** Static collision rects per physics floor, for the penetration safety net. */
  private readonly solidRects = new Map<string, Rect[]>();
  /** Stairs per physics floor. */
  private readonly stairsByFloor = new Map<string, StairLink[]>();
  private input: InputCommand = { move: zeroVec(), dash: false };
  private timeMs = 0;
  private tickCount = 0;
  private fps = 0;
  private rngState = 481516234;
  private bankedDots = 0;
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
      this.addBot(spawn);
    }

    this.spawnDots();
  }

  static async create(options: SimulationOptions = {}): Promise<DotBotSimulation> {
    const rapier = await loadRapier();
    const config = { ...defaultGameConfig, ...options.config };
    const map = options.map ?? downtownMap;

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

  private addBot(spawn: BotSpawn): void {
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

    const bot: InternalBot = {
      id: spawn.id,
      name: spawn.name,
      team: spawn.team,
      color: spawn.color,
      position: { ...spawn.position },
      radius: this.config.botRadius,
      state,
      floorId,
      maxShields,
      shields,
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
      consumedRespawnMs: 0,
    };

    this.setBotPhysicsState(bot, state);
    this.bots.set(bot.id, bot);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  applyInput(input: InputCommand): void {
    this.input = {
      move: normalizeInputVector(input.move),
      dash: input.dash,
    };
  }

  setMeasuredFps(fps: number): void {
    this.fps = fps;
  }

  step(): void {
    const dtSeconds = 1 / this.config.tickHz;
    const dtMs = dtSeconds * 1000;

    this.timeMs += dtMs;
    this.tickCount += 1;

    this.ageNoises(dtMs);
    this.updateTimers(dtMs);

    for (const bot of this.bots.values()) {
      bot.prevPosition = { ...bot.position };
    }

    this.updatePlayerIntent();
    this.updateBotAi(dtMs);
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
    const player = this.bots.get("player");

    return {
      timeMs: this.timeMs,
      playerId: "player",
      map: this.map,
      bots,
      dots,
      coverages: [...this.coverages.values()].map((coverage) => ({ ...coverage })),
      noises: this.noises.map((noise) => ({ ...noise, position: { ...noise.position } })),
      bankedDots: this.bankedDots,
      locationLabel: player ? locationLabel(this.map, player.floorId, player.position) : this.map.name.toUpperCase(),
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
    this.world.free();
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
    }
  }

  private updatePlayerIntent(): void {
    const player = this.bots.get("player");

    if (!player || player.state !== "alive") {
      return;
    }

    player.desiredMove = this.input.move;

    if (length(this.input.move) > 0.05) {
      player.lastAim = this.input.move;
    }

    if (this.input.dash && player.dashCooldownMs <= 0 && player.dashActiveMs <= 0) {
      player.dashActiveMs = this.config.dashDurationMs;
      player.dashCooldownMs = this.config.dashCooldownMs;
      this.emitNoise("dash", player.position, player.floorId, NOISE_LOUDNESS.dash);
    }
  }

  private updateBotAi(dtMs: number): void {
    for (const bot of this.bots.values()) {
      if (bot.team === "player" || bot.state !== "alive") {
        continue;
      }

      const target = this.pickBotTarget(bot, dtMs);
      const desired = steerToward(bot.position, target);
      bot.desiredMove = desired;

      if (length(desired) > 0.05) {
        bot.lastAim = desired;
      }
    }
  }

  private sameArena(bot: InternalBot, floorId: string, position: Vec2): boolean {
    return contextKey(this.map, bot.floorId, bot.position) === contextKey(this.map, floorId, position);
  }

  private pickBotTarget(bot: InternalBot, dtMs: number): AiTarget {
    const reachable = (target: { floorId: string; position: Vec2 }) => this.sameArena(bot, target.floorId, target.position);

    const friendlyDowned = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "downed" && areFriendly(bot, target) && reachable(target))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (friendlyDowned && bot.inventoryDots > 0 && distance(bot.position, friendlyDowned.position) < 280) {
      return makeAiTarget(friendlyDowned.position, bot.radius * 0.42, bot.radius * 3);
    }

    const hostileDowned = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "downed" && !areFriendly(bot, target) && reachable(target))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (hostileDowned && distance(bot.position, hostileDowned.position) < 330) {
      return makeAiTarget(hostileDowned.position, bot.radius * 0.42, bot.radius * 3);
    }

    const dot = [...this.dots.values()]
      .filter((candidate) => candidate.active && bot.inventoryDots < this.config.maxInventoryDots && reachable(candidate))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (dot && distance(bot.position, dot.position) < 310) {
      return makeAiTarget(dot.position, Math.max(2, bot.radius - dot.radius - 4), bot.radius * 3.2);
    }

    const hostileAlive = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "alive" && !areFriendly(bot, target) && reachable(target))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (
      hostileAlive &&
      distance(bot.position, hostileAlive.position) < 380 &&
      hasLineOfSight(this.map, contextKey(this.map, bot.floorId, bot.position), bot.position, hostileAlive.position)
    ) {
      // Stop just outside contact range (sum of radii ~2r), otherwise the
      // chaser presses into its target forever and bulldozes it across the map.
      return makeAiTarget(hostileAlive.position, bot.radius * 2.3, bot.radius * 4.5);
    }

    // Idle allies escort the player instead of wandering off.
    if (bot.team === "ally") {
      const player = this.bots.get("player");

      if (player && player.state === "alive" && this.sameArena(bot, player.floorId, player.position)) {
        return makeAiTarget(player.position, bot.radius * 3, bot.radius * 6);
      }
    }

    bot.aiRetargetMs -= dtMs;

    if (bot.aiRetargetMs <= 0 || distance(bot.position, bot.aiWanderTarget) < 48) {
      bot.aiWanderTarget = this.pickWanderTarget(bot);
      bot.aiRetargetMs = 1400 + this.nextRandom() * 1500;
    }

    return makeAiTarget(bot.aiWanderTarget, 48, bot.radius * 4);
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

      const speed =
        bot.id === "player" && bot.dashActiveMs > 0
          ? this.config.dashSpeed
          : bot.team === "player"
            ? this.config.playerSpeed
            : this.config.botSpeed;
      const direction = bot.id === "player" && bot.dashActiveMs > 0 ? bot.lastAim : bot.desiredMove;
      bot.body.setLinvel(scale(direction, speed), true);
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
   * Only the player rides stairs for now; AI keeps to its own floor.
   */
  private resolveStairs(): void {
    const player = this.bots.get("player");

    if (!player || player.state !== "alive") {
      return;
    }

    for (const stair of this.stairsByFloor.get(player.floorId) ?? []) {
      if (!rectContainsPoint(stair.rect, player.position) || !rectContainsPoint(stair.rect, player.prevPosition)) {
        continue;
      }

      const { entry, exit } = stairHalves(stair);

      if (!rectContainsPoint(entry, player.prevPosition) || !rectContainsPoint(exit, player.position)) {
        continue;
      }

      const sourceFloor = player.floorId;
      const targetFloor = physicsFloorId(this.map, stair.toFloorId);
      player.floorId = targetFloor;
      player.collider.setCollisionGroups(this.interactionGroups(targetFloor));

      // Stairs announce themselves on both connected floors.
      this.emitNoise("stairs", player.position, sourceFloor, NOISE_LOUDNESS.stairs);
      this.emitNoise("stairs", player.position, targetFloor, NOISE_LOUDNESS.stairs);
      break;
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

    target.shields = Math.max(0, target.shields - 1);
    target.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
    this.emitNoise("impact", target.position, target.floorId, NOISE_LOUDNESS.impact);

    if (target.shields <= 0) {
      target.state = "downed";
      target.dashActiveMs = 0;
      target.body.setLinvel(zeroVec(), true);
      this.setBotPhysicsState(target, "downed");
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

      if (kind === "revive" && coveringBot.inventoryDots <= 0) {
        this.coverages.delete(coverageKey);
        continue;
      }

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
    const player = this.bots.get("player");

    for (const point of this.map.extractionPoints) {
      const coverageKey = `extract:${point.id}`;
      const eligible =
        player &&
        player.state === "alive" &&
        player.floorId === OUTDOOR_FLOOR_ID &&
        player.inventoryDots > 0 &&
        rectContainsPoint(point.rect, player.position);

      if (!eligible) {
        this.coverages.delete(coverageKey);
        continue;
      }

      const existing = this.coverages.get(coverageKey);
      const progressMs = existing ? existing.progressMs + dtMs : dtMs;

      if (this.channelPingDue(progressMs, dtMs)) {
        this.emitNoise("channel", player.position, player.floorId, NOISE_LOUDNESS.extractChannel);
      }

      this.coverages.set(coverageKey, {
        kind: "extract",
        actorId: player.id,
        targetId: point.id,
        progressMs,
        durationMs: this.config.extractionDurationMs,
      });

      if (progressMs >= this.config.extractionDurationMs) {
        this.bankedDots += player.inventoryDots;
        player.inventoryDots = 0;
        this.coverages.delete(coverageKey);
      }
    }
  }

  private reviveBot(target: InternalBot, reviver: InternalBot): void {
    reviver.inventoryDots = Math.max(0, reviver.inventoryDots - 1);
    target.state = "alive";
    target.shields = 1;
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
  }

  private consumeBot(target: InternalBot, consumer: InternalBot): void {
    const loot = Math.min(this.config.maxInventoryDots - consumer.inventoryDots, target.inventoryDots);
    consumer.inventoryDots += Math.max(0, loot);
    target.state = "consumed";
    target.shields = 0;
    target.inventoryDots = 0;
    target.consumedRespawnMs = this.config.respawnDelayMs;
    this.setBotPhysicsState(target, "consumed");
  }

  private respawnConsumedBots(dtMs: number): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "consumed") {
        continue;
      }

      bot.consumedRespawnMs -= dtMs;

      if (bot.consumedRespawnMs > 0) {
        continue;
      }

      bot.state = "alive";
      bot.shields = bot.maxShields;
      bot.inventoryDots = bot.team === "player" || bot.team === "ally" ? 1 : 0;
      bot.dashActiveMs = 0;
      bot.dashCooldownMs = 0;
      bot.invulnerabilityMs = this.config.shieldInvulnerabilityMs;
      bot.floorId = bot.spawnFloorId;
      bot.position = { ...bot.spawn };
      bot.prevPosition = { ...bot.spawn };
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

function areFriendly(a: Pick<DotBotEntity, "team">, b: Pick<DotBotEntity, "team">): boolean {
  return FRIENDLY_TEAMS.has(a.team) && FRIENDLY_TEAMS.has(b.team);
}

function toBotSnapshot(bot: InternalBot): DotBotEntity {
  return {
    id: bot.id,
    name: bot.name,
    team: bot.team,
    color: bot.color,
    position: { ...bot.position },
    radius: bot.radius,
    state: bot.state,
    floorId: bot.floorId,
    maxShields: bot.maxShields,
    shields: bot.shields,
    inventoryDots: bot.inventoryDots,
    dashCooldownMs: bot.dashCooldownMs,
    dashActiveMs: bot.dashActiveMs,
    invulnerabilityMs: bot.invulnerabilityMs,
  };
}

function rectContainsPoint(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function separateCircleFromRect(position: Vec2, radius: number, wall: Rect): Vec2 {
  const closestX = clamp(position.x, wall.x, wall.x + wall.w);
  const closestY = clamp(position.y, wall.y, wall.y + wall.h);
  const offset = {
    x: position.x - closestX,
    y: position.y - closestY,
  };
  const distanceSquared = offset.x * offset.x + offset.y * offset.y;
  const radiusSquared = radius * radius;

  if (distanceSquared >= radiusSquared) {
    return position;
  }

  if (distanceSquared > 0.0001) {
    const distanceToWall = Math.sqrt(distanceSquared);
    const push = (radius - distanceToWall) / distanceToWall;
    return {
      x: position.x + offset.x * push,
      y: position.y + offset.y * push,
    };
  }

  const left = Math.abs(position.x - wall.x);
  const right = Math.abs(wall.x + wall.w - position.x);
  const top = Math.abs(position.y - wall.y);
  const bottom = Math.abs(wall.y + wall.h - position.y);
  const nearest = Math.min(left, right, top, bottom);

  if (nearest === left) {
    return { x: wall.x - radius, y: position.y };
  }

  if (nearest === right) {
    return { x: wall.x + wall.w + radius, y: position.y };
  }

  if (nearest === top) {
    return { x: position.x, y: wall.y - radius };
  }

  return { x: position.x, y: wall.y + wall.h + radius };
}

function canCoverDownedBot(actor: InternalBot, target: InternalBot, minimumTolerance: number): boolean {
  const downedFootprintRadius = target.radius * 0.55;
  return distance(actor.position, target.position) <= Math.max(minimumTolerance, actor.radius + downedFootprintRadius);
}

function makeAiTarget(position: Vec2, stopDistance: number, slowDistance: number): AiTarget {
  return {
    position,
    stopDistance,
    slowDistance: Math.max(slowDistance, stopDistance + 1),
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
