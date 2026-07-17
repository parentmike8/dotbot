import type { DotBotEntity, GameSnapshot, MineEntity, NoiseEvent, Vec2 } from "@dotbot/game/types";

export type TimelineSnapshot = { tick: number; snapshot: GameSnapshot };

export type TimelineSample = {
  snapshot: GameSnapshot;
  bufferDepthSnapshots: number;
  underRunTicks: number;
};

export function sampleTimeline(
  samples: readonly TimelineSnapshot[],
  renderTick: number,
  maxExtrapolationTicks: number,
): TimelineSample | null {
  if (samples.length === 0) return null;
  const newest = samples[samples.length - 1];
  const bufferDepthSnapshots = samples.filter((sample) => sample.tick >= renderTick).length;

  if (renderTick <= samples[0].tick) {
    return { snapshot: samples[0].snapshot, bufferDepthSnapshots, underRunTicks: 0 };
  }

  let older = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    const newer = samples[index];
    if (renderTick <= newer.tick) {
      const span = Math.max(1, newer.tick - older.tick);
      return {
        snapshot: interpolateSnapshot(older.snapshot, newer.snapshot, (renderTick - older.tick) / span, renderTick),
        bufferDepthSnapshots,
        underRunTicks: 0,
      };
    }
    older = newer;
  }

  const previous = samples.at(-2) ?? newest;
  const span = Math.max(1, newest.tick - previous.tick);
  const underRunTicks = Math.max(0, renderTick - newest.tick);
  const extrapolatedTicks = Math.min(underRunTicks, maxExtrapolationTicks);
  return {
    snapshot: interpolateSnapshot(
      previous.snapshot,
      newest.snapshot,
      1 + extrapolatedTicks / span,
      newest.tick + extrapolatedTicks,
    ),
    bufferDepthSnapshots,
    underRunTicks,
  };
}

export function capRemoteRecovery(
  previous: GameSnapshot | null,
  target: GameSnapshot,
  ownBotId: string,
  elapsedMs: number,
  maxCorrectionSpeedPxPerSecond: number,
): GameSnapshot {
  if (!previous) return target;
  const priorBots = new Map(previous.bots.map((bot) => [bot.id, bot]));
  const maxDistance = Math.max(0, maxCorrectionSpeedPxPerSecond * elapsedMs / 1000);
  return {
    ...target,
    bots: target.bots.map((bot) => {
      if (bot.id === ownBotId) return bot;
      const prior = priorBots.get(bot.id);
      if (!prior || prior.floorId !== bot.floorId) return bot;
      return { ...bot, position: cappedToward(prior.position, bot.position, maxDistance) };
    }),
  };
}

/**
 * Overlays the FRESHEST known combat state (downed/consumed, shield plates,
 * invulnerability) onto the interpolation-delayed remote bots. Positions must
 * ride the smooth delayed timeline, but plate state is discrete and combat
 * feedback that arrives a buffer-length late reads as "my hit didn't count" —
 * a dash stops on the enemy NOW, so their arc must break NOW.
 */
export function fastForwardCombatState(sampled: GameSnapshot, freshest: GameSnapshot, ownBotId: string): GameSnapshot {
  const freshBots = new Map(freshest.bots.map((bot) => [bot.id, bot]));
  return {
    ...sampled,
    bots: sampled.bots.map((bot) => {
      if (bot.id === ownBotId) return bot;
      const fresh = freshBots.get(bot.id);
      if (!fresh) return bot;
      return {
        ...bot,
        state: fresh.state,
        shields: fresh.shields,
        shieldSegments: fresh.shieldSegments,
        invulnerabilityMs: fresh.invulnerabilityMs,
      };
    }),
  };
}

function interpolateSnapshot(older: GameSnapshot, newer: GameSnapshot, alpha: number, renderTick: number): GameSnapshot {
  const newerBots = new Map(newer.bots.map((bot) => [bot.id, bot]));
  const newerDots = new Map(newer.dots.map((dot) => [dot.id, dot]));
  const newerMines = new Map(newer.mines.map((mine) => [mine.id, mine]));
  const newerCoverages = new Map(newer.coverages.map((coverage) => [coverageKey(coverage), coverage]));
  const newerNoises = new Map(newer.noises.map((noise) => [noise.id, noise]));

  return {
    ...older,
    timeMs: lerp(older.timeMs, newer.timeMs, alpha),
    bots: older.bots.map((bot) => interpolateBot(bot, newerBots.get(bot.id), alpha)),
    dots: older.dots.map((dot) => {
      const next = newerDots.get(dot.id);
      return next ? { ...dot, captureProgressMs: lerp(dot.captureProgressMs, next.captureProgressMs, alpha) } : dot;
    }),
    mines: older.mines.map((mine) => interpolateMine(mine, newerMines.get(mine.id), alpha)),
    coverages: older.coverages.map((coverage) => {
      const next = newerCoverages.get(coverageKey(coverage));
      return next ? { ...coverage, progressMs: lerp(coverage.progressMs, next.progressMs, alpha) } : coverage;
    }),
    noises: older.noises.map((noise) => interpolateNoise(noise, newerNoises.get(noise.id), alpha)),
    debug: { ...older.debug, tickCount: Math.round(renderTick) },
  };
}

function interpolateBot(bot: DotBotEntity, next: DotBotEntity | undefined, alpha: number): DotBotEntity {
  if (!next || bot.floorId !== next.floorId) return bot;
  const nextPings = new Map(next.radarPings.map((ping) => [`${ping.x}:${ping.y}`, ping]));
  return {
    ...bot,
    position: interpolatePoint(bot.position, next.position, alpha),
    facing: lerpAngle(bot.facing, next.facing, alpha),
    radarActiveMs: lerp(bot.radarActiveMs, next.radarActiveMs, alpha),
    radarPings: bot.radarPings.map((ping) => {
      const nextPing = nextPings.get(`${ping.x}:${ping.y}`);
      return nextPing ? { ...ping, ageMs: lerp(ping.ageMs, nextPing.ageMs, alpha) } : ping;
    }),
    dashCooldownMs: lerp(bot.dashCooldownMs, next.dashCooldownMs, alpha),
    dashActiveMs: lerp(bot.dashActiveMs, next.dashActiveMs, alpha),
    invulnerabilityMs: lerp(bot.invulnerabilityMs, next.invulnerabilityMs, alpha),
    incognitoMs: lerp(bot.incognitoMs, next.incognitoMs, alpha),
  };
}

function interpolateMine(mine: MineEntity, next: MineEntity | undefined, alpha: number): MineEntity {
  if (!next || mine.floorId !== next.floorId) return mine;
  return { ...mine, position: interpolatePoint(mine.position, next.position, alpha) };
}

function interpolateNoise(noise: NoiseEvent, next: NoiseEvent | undefined, alpha: number): NoiseEvent {
  if (!next || noise.floorId !== next.floorId) return noise;
  return {
    ...noise,
    position: interpolatePoint(noise.position, next.position, alpha),
    loudness: lerp(noise.loudness, next.loudness, alpha),
    ageMs: lerp(noise.ageMs, next.ageMs, alpha),
  };
}

function coverageKey(coverage: GameSnapshot["coverages"][number]): string {
  return `${coverage.kind}:${coverage.actorId}:${coverage.targetId}`;
}

function interpolatePoint(older: Vec2, newer: Vec2, alpha: number): Vec2 {
  return { x: lerp(older.x, newer.x, alpha), y: lerp(older.y, newer.y, alpha) };
}

function cappedToward(from: Vec2, to: Vec2, maxDistance: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= maxDistance || distance === 0) return { ...to };
  const scale = maxDistance / distance;
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpAngle(a: number, b: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * alpha;
}
