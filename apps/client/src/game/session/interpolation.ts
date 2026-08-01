import type { DotBotEntity, GameSnapshot, MineEntity, NoiseEvent, Vec2 } from "@dotbot/game/types";

export type TimelineSnapshot = { tick: number; snapshot: GameSnapshot };

export type TimelineSample = {
  snapshot: GameSnapshot;
  bufferDepthSnapshots: number;
  underRunTicks: number;
};

type SnapshotIndexes = {
  bots: ReadonlyMap<string, DotBotEntity>;
  dots: ReadonlyMap<string, GameSnapshot["dots"][number]>;
  mines: ReadonlyMap<string, MineEntity>;
  coverages: ReadonlyMap<string, GameSnapshot["coverages"][number]>;
  noises: ReadonlyMap<string, NoiseEvent>;
  doors: ReadonlyMap<string, NonNullable<GameSnapshot["doors"]>[number]>;
};

type ArrayIndex<T> = {
  refs: readonly T[];
  keys: readonly string[];
  byKey: ReadonlyMap<string, T>;
};

/**
 * Keep a guarded lookup index with each entity array instead of rebuilding six
 * Maps at 60 Hz. GameSnapshot is intentionally mutable today, including entity
 * replacement/addition/removal in tests and downstream consumers, so a WeakMap
 * hit alone is not proof that an index is current.
 *
 * The validation walk catches:
 * - a replacement or reorder by reference,
 * - an addition/removal by length,
 * - an in-place id/key mutation by recomputing the key.
 *
 * Other in-place field mutations are already visible through the Map's live
 * entity reference. A changed array gets a new WeakMap key. Rebuilding an array
 * in place overwrites its one cache entry, releasing the old refs. Once an array
 * leaves the snapshot/history buffer, both it and its index remain collectible.
 */
function guardedIndex<T>(keyFor: (value: T) => string): (values: readonly T[]) => ReadonlyMap<string, T> {
  const indexes = new WeakMap<readonly T[], ArrayIndex<T>>();
  return (values) => {
    const cached = indexes.get(values);
    if (cached && cached.refs.length === values.length) {
      let valid = true;
      for (let index = 0; index < values.length; index += 1) {
        if (cached.refs[index] !== values[index] || cached.keys[index] !== keyFor(values[index])) {
          valid = false;
          break;
        }
      }
      if (valid) return cached.byKey;
    }

    const refs = [...values];
    const keys = refs.map(keyFor);
    const byKey = new Map<string, T>();
    for (let index = 0; index < refs.length; index += 1) byKey.set(keys[index], refs[index]);
    indexes.set(values, { refs, keys, byKey });
    return byKey;
  };
}

const botIndex = guardedIndex<DotBotEntity>((bot) => bot.id);
const dotIndex = guardedIndex<GameSnapshot["dots"][number]>((dot) => dot.id);
const mineIndex = guardedIndex<MineEntity>((mine) => mine.id);
const coverageIndex = guardedIndex<GameSnapshot["coverages"][number]>(coverageKey);
const noiseIndex = guardedIndex<NoiseEvent>((noise) => noise.id);
const doorIndex = guardedIndex<NonNullable<GameSnapshot["doors"]>[number]>((door) => door.id);
const noDoors = Object.freeze([]) as readonly NonNullable<GameSnapshot["doors"]>[number][];

function indexesFor(snapshot: GameSnapshot): SnapshotIndexes {
  return {
    bots: botIndex(snapshot.bots),
    dots: dotIndex(snapshot.dots),
    mines: mineIndex(snapshot.mines),
    coverages: coverageIndex(snapshot.coverages),
    noises: noiseIndex(snapshot.noises),
    doors: doorIndex(snapshot.doors ?? noDoors),
  };
}

export function sampleTimeline(
  samples: readonly TimelineSnapshot[],
  renderTick: number,
  maxExtrapolationTicks: number,
): TimelineSample | null {
  if (samples.length === 0) return null;
  const newest = samples[samples.length - 1];
  let bufferDepthSnapshots = 0;
  for (const sample of samples) {
    if (sample.tick >= renderTick) bufferDepthSnapshots += 1;
  }

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
  const freshBots = botIndex(freshest.bots);
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
  const olderIndexes = indexesFor(older);
  const {
    bots: newerBots,
    dots: newerDots,
    mines: newerMines,
    coverages: newerCoverages,
    noises: newerNoises,
    doors: newerDoors,
  } = indexesFor(newer);
  const afterBoundary = alpha >= 1;

  return {
    ...older,
    timeMs: lerp(older.timeMs, newer.timeMs, alpha),
    bots: (afterBoundary ? newer.bots : older.bots).map((bot) => {
      const previous = olderIndexes.bots.get(bot.id) ?? bot;
      return interpolateBot(previous, newerBots.get(bot.id), alpha);
    }),
    dots: (afterBoundary ? newer.dots : older.dots).map((dot) => {
      const previous = olderIndexes.dots.get(dot.id) ?? dot;
      const next = newerDots.get(dot.id);
      return next ? { ...next, captureProgressMs: lerp(previous.captureProgressMs, next.captureProgressMs, alpha) } : { ...dot };
    }),
    mines: (afterBoundary ? newer.mines : older.mines).map((mine) =>
      interpolateMine(olderIndexes.mines.get(mine.id) ?? mine, newerMines.get(mine.id), alpha)),
    coverages: (afterBoundary ? newer.coverages : older.coverages).map((coverage) => {
      const previous = olderIndexes.coverages.get(coverageKey(coverage)) ?? coverage;
      const next = newerCoverages.get(coverageKey(coverage));
      return next ? { ...next, progressMs: lerp(previous.progressMs, next.progressMs, alpha) } : { ...coverage };
    }),
    noises: (afterBoundary ? newer.noises : older.noises).map((noise) =>
      interpolateNoise(olderIndexes.noises.get(noise.id) ?? noise, newerNoises.get(noise.id), alpha)),
    doors: (afterBoundary ? (newer.doors ?? []) : (older.doors ?? [])).map((door) => {
      const previous = olderIndexes.doors.get(door.id) ?? door;
      const next = newerDoors.get(door.id);
      return next ? { ...next, openness: lerp(previous.openness, next.openness, alpha) } : { ...door };
    }),
    rivalsAlive: afterBoundary ? newer.rivalsAlive : older.rivalsAlive,
    debug: { ...older.debug, tickCount: Math.round(renderTick) },
  };
}

function interpolateBot(bot: DotBotEntity, next: DotBotEntity | undefined, alpha: number): DotBotEntity {
  if (!next || bot.floorId !== next.floorId) {
    const chosen = next && alpha >= 1 ? next : bot;
    return {
      ...chosen,
      position: { ...chosen.position },
      shieldSegments: [...chosen.shieldSegments],
      bays: chosen.bays.map((item) => item && { ...item }),
      hold: chosen.hold.map((item) => ({ ...item })),
      radarPings: chosen.radarPings.map((ping) => ({ ...ping })),
    };
  }
  // Radar rings are normally absent. Avoid constructing one empty Map per bot
  // per display frame while preserving a freshly materialized output array.
  let radarPings: DotBotEntity["radarPings"] = [];
  const sourcePings = alpha >= 1 ? next.radarPings : bot.radarPings;
  if (sourcePings.length > 0) {
    const previousPings = new Map(bot.radarPings.map((ping) => [ping.botId, ping]));
    const nextPings = new Map(next.radarPings.map((ping) => [ping.botId, ping]));
    radarPings = sourcePings.map((ping) => {
      const previousPing = previousPings.get(ping.botId) ?? ping;
      const nextPing = nextPings.get(ping.botId);
      if (!nextPing) return { ...ping };
      const refreshedSample = nextPing.ageMs < previousPing.ageMs
        || nextPing.x !== previousPing.x
        || nextPing.y !== previousPing.y
        || nextPing.floorId !== previousPing.floorId;
      // A Radar point is sampled intel, not a continuously tracked body. Hold
      // the old stale return through the interval and switch only at the newer
      // snapshot tick; tweening would expose the future sample before it exists.
      if (refreshedSample) return { ...(alpha >= 1 ? nextPing : previousPing) };
      return {
        ...nextPing,
        x: previousPing.x,
        y: previousPing.y,
        ageMs: lerp(previousPing.ageMs, nextPing.ageMs, alpha),
      };
    });
  }
  return {
    ...bot,
    position: interpolatePoint(bot.position, next.position, alpha),
    facing: lerpAngle(bot.facing, next.facing, alpha),
    radarActiveMs: lerp(bot.radarActiveMs, next.radarActiveMs, alpha),
    radarPings,
    dashOverchargeMs: lerp(bot.dashOverchargeMs, next.dashOverchargeMs, alpha),
    dashCooldownMs: lerp(bot.dashCooldownMs, next.dashCooldownMs, alpha),
    dashActiveMs: lerp(bot.dashActiveMs, next.dashActiveMs, alpha),
    invulnerabilityMs: lerp(bot.invulnerabilityMs, next.invulnerabilityMs, alpha),
    incognitoMs: lerp(bot.incognitoMs, next.incognitoMs, alpha),
  };
}

function interpolateMine(mine: MineEntity, next: MineEntity | undefined, alpha: number): MineEntity {
  if (!next || mine.floorId !== next.floorId) {
    return { ...mine, position: { ...mine.position }, revealedToBotIds: [...mine.revealedToBotIds] };
  }
  const authorized = alpha >= 1 ? next : mine;
  return {
    ...authorized,
    position: interpolatePoint(mine.position, next.position, alpha),
    revealedToBotIds: [...authorized.revealedToBotIds],
  };
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
