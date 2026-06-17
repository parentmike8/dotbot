import type RAPIER from "@dimforge/rapier2d-compat";
import { defaultGameConfig } from "./config";
import { miniCityBlockMap } from "./content/miniCityBlock";
import {
  add,
  clamp,
  distance,
  length,
  normalize,
  normalizeInputVector,
  scale,
  subtract,
  zeroVec,
} from "./math";
import { loadRapier } from "./rapier";
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
  MapDefinition,
  Vec2,
} from "./types";

type RapierApi = typeof RAPIER;
type RapierWorld = RAPIER.World;
type RapierBody = RAPIER.RigidBody;
type RapierCollider = RAPIER.Collider;

type InternalBot = DotBotEntity & {
  spawn: Vec2;
  body: RapierBody;
  collider: RapierCollider;
  desiredMove: Vec2;
  lastAim: Vec2;
  aiWanderTarget: Vec2;
  aiRetargetMs: number;
  consumedRespawnMs: number;
};

type InternalDot = DotEntity;

type ActiveCoverage = CoverageSnapshot;

type SimulationOptions = {
  map?: MapDefinition;
  config?: Partial<GameConfig>;
};

const FRIENDLY_TEAMS = new Set<BotTeam>(["player", "ally"]);

export class DotBotSimulation {
  readonly config: GameConfig;
  readonly map: MapDefinition;

  private readonly rapier: RapierApi;
  private readonly world: RapierWorld;
  private readonly bots = new Map<string, InternalBot>();
  private readonly dots = new Map<string, InternalDot>();
  private readonly coverages = new Map<string, ActiveCoverage>();
  private input: InputCommand = { move: zeroVec(), dash: false };
  private timeMs = 0;
  private tickCount = 0;
  private fps = 0;
  private rngState = 481516234;

  private constructor(rapier: RapierApi, map: MapDefinition, config: GameConfig) {
    this.rapier = rapier;
    this.map = map;
    this.config = config;
    this.world = new this.rapier.World({ x: 0, y: 0 });
    this.world.timestep = 1 / config.tickHz;
    this.world.lengthUnit = config.botRadius;

    for (const wall of map.walls) {
      const body = this.world.createRigidBody(
        this.rapier.RigidBodyDesc.fixed().setTranslation(wall.x + wall.w / 2, wall.y + wall.h / 2),
      );
      this.world.createCollider(this.rapier.ColliderDesc.cuboid(wall.w / 2, wall.h / 2), body);
    }

    for (const spawn of map.botSpawns) {
      this.addBot(spawn);
    }

    for (const dotSpawn of map.dotSpawns) {
      this.dots.set(dotSpawn.id, {
        id: dotSpawn.id,
        position: { ...dotSpawn.position },
        radius: dotSpawn.radius ?? config.dotRadius,
        color: dotSpawn.color,
        active: true,
        captureProgressMs: 0,
      });
    }
  }

  static async create(options: SimulationOptions = {}): Promise<DotBotSimulation> {
    const rapier = await loadRapier();
    const config = { ...defaultGameConfig, ...options.config };
    const map = options.map ?? miniCityBlockMap;

    return new DotBotSimulation(rapier, map, config);
  }

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

    this.updateTimers(dtMs);
    this.updatePlayerIntent();
    this.updateBotAi(dtMs);
    this.applyMovement();

    this.world.step();
    this.resolveWallPenetration();
    this.syncPhysicsPositions();
    this.resolveCombat();
    this.resolveDotCapture(dtMs);
    this.resolveDownedCoverage(dtMs);
    this.respawnConsumedBots(dtMs);
  }

  getSnapshot(): GameSnapshot {
    const bots = [...this.bots.values()].map(toBotSnapshot);
    const dots = [...this.dots.values()].map((dot) => ({ ...dot, position: { ...dot.position } }));

    return {
      timeMs: this.timeMs,
      playerId: "player",
      map: this.map,
      bots,
      dots,
      coverages: [...this.coverages.values()].map((coverage) => ({ ...coverage })),
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

  private addBot(spawn: BotSpawn): void {
    const maxShields = spawn.maxShields ?? this.config.maxShields;
    const state = spawn.state ?? "alive";
    const shields = spawn.shields ?? (state === "alive" ? maxShields : 0);
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
      this.rapier.ColliderDesc.ball(this.config.botRadius)
        .setRestitution(0.14)
        .setFriction(0.22)
        .setDensity(1),
      body,
    );

    const bot: InternalBot = {
      id: spawn.id,
      name: spawn.name,
      team: spawn.team,
      color: spawn.color,
      position: { ...spawn.position },
      radius: this.config.botRadius,
      state,
      maxShields,
      shields,
      inventoryDots: spawn.inventoryDots ?? 0,
      dashCooldownMs: 0,
      dashActiveMs: 0,
      invulnerabilityMs: 0,
      spawn: { ...spawn.position },
      body,
      collider,
      desiredMove: zeroVec(),
      lastAim: { x: 1, y: 0 },
      aiWanderTarget: { ...spawn.position },
      aiRetargetMs: 0,
      consumedRespawnMs: 0,
    };

    this.setBotPhysicsState(bot, state);
    this.bots.set(bot.id, bot);
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
    }
  }

  private updateBotAi(dtMs: number): void {
    for (const bot of this.bots.values()) {
      if (bot.team === "player" || bot.state !== "alive") {
        continue;
      }

      const target = this.pickBotTarget(bot, dtMs);
      const desired = normalize(subtract(target, bot.position));
      bot.desiredMove = desired;

      if (length(desired) > 0.05) {
        bot.lastAim = desired;
      }
    }
  }

  private pickBotTarget(bot: InternalBot, dtMs: number): Vec2 {
    const friendlyDowned = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "downed" && areFriendly(bot, target))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (friendlyDowned && bot.inventoryDots > 0 && distance(bot.position, friendlyDowned.position) < 280) {
      return friendlyDowned.position;
    }

    const hostileDowned = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "downed" && !areFriendly(bot, target))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (hostileDowned && distance(bot.position, hostileDowned.position) < 330) {
      return hostileDowned.position;
    }

    const dot = [...this.dots.values()]
      .filter((candidate) => candidate.active && bot.inventoryDots < this.config.maxInventoryDots)
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (dot && distance(bot.position, dot.position) < 310) {
      return dot.position;
    }

    const hostileAlive = [...this.bots.values()]
      .filter((target) => target.id !== bot.id && target.state === "alive" && !areFriendly(bot, target))
      .sort((a, b) => distance(bot.position, a.position) - distance(bot.position, b.position))[0];

    if (hostileAlive && distance(bot.position, hostileAlive.position) < 380) {
      return hostileAlive.position;
    }

    bot.aiRetargetMs -= dtMs;

    if (bot.aiRetargetMs <= 0 || distance(bot.position, bot.aiWanderTarget) < 48) {
      bot.aiWanderTarget = {
        x: 90 + this.nextRandom() * (this.map.width - 180),
        y: 90 + this.nextRandom() * (this.map.height - 180),
      };
      bot.aiRetargetMs = 1400 + this.nextRandom() * 1500;
    }

    return bot.aiWanderTarget;
  }

  private applyMovement(): void {
    for (const bot of this.bots.values()) {
      if (bot.state !== "alive") {
        bot.body.setLinvel(zeroVec(), true);
        continue;
      }

      const speed =
        bot.id === "player" && bot.dashActiveMs > 0 ? this.config.dashSpeed : bot.team === "player" ? this.config.playerSpeed : this.config.botSpeed;
      const direction = bot.id === "player" && bot.dashActiveMs > 0 ? bot.lastAim : bot.desiredMove;
      const velocity = scale(direction, speed);
      bot.body.setLinvel(velocity, true);
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

      let position = bot.body.translation();

      for (let iteration = 0; iteration < 3; iteration += 1) {
        let moved = false;

        for (const wall of this.map.walls) {
          const next = separateCircleFromRect(position, bot.radius, wall);

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

  private resolveCombat(): void {
    const aliveBots = [...this.bots.values()].filter((bot) => bot.state === "alive");

    for (let i = 0; i < aliveBots.length; i += 1) {
      for (let j = i + 1; j < aliveBots.length; j += 1) {
        const a = aliveBots[i];
        const b = aliveBots[j];
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
        (bot) => bot.id !== downed.id && distance(bot.position, downed.position) <= this.config.coverCenterTolerance,
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
      const coverage: ActiveCoverage = {
        kind,
        actorId: coveringBot.id,
        targetId: downed.id,
        progressMs,
        durationMs: this.config.coverDurationMs,
      };

      this.coverages.set(coverageKey, coverage);

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
      bot.position = { ...bot.spawn };
      bot.body.setEnabled(true);
      bot.collider.setEnabled(true);
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
      bot.collider.setEnabled(true);
      bot.collider.setSensor(true);
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
    maxShields: bot.maxShields,
    shields: bot.shields,
    inventoryDots: bot.inventoryDots,
    dashCooldownMs: bot.dashCooldownMs,
    dashActiveMs: bot.dashActiveMs,
    invulnerabilityMs: bot.invulnerabilityMs,
  };
}

function separateCircleFromRect(position: Vec2, radius: number, wall: { x: number; y: number; w: number; h: number }): Vec2 {
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
