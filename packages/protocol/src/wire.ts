import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import type { DotBotEntity, DotEntity, GameSnapshot, MineEntity, NoiseEvent, CoverageSnapshot, RadarPing } from "@dotbot/game/types";
import type { SimEvent } from "@dotbot/game/types";
import type { EntityMeta, FullWireSnapshot, WireBot, WireDot, WireDotContextSync, WireDotDelta, WireMine, WireSnapshot } from "./messages";
import type { WireSimEvent } from "./messages";
import { itemFromCode, itemToCode } from "./items";

const roundPosition = (value: number) => Math.round(value * 100) / 100;
const roundFloat = (value: number) => Math.round(value * 100) / 100;
const roundMs = (value: number) => Math.round(value);

export function toEntityMeta(bot: DotBotEntity): EntityMeta {
  return {
    id: bot.id,
    name: bot.name,
    squadId: bot.squadId,
    isAmbient: bot.isAmbient,
    maxShields: bot.maxShields,
    radius: bot.radius,
    color: bot.color,
  };
}

export function toWireSnapshot(snapshot: GameSnapshot): FullWireSnapshot {
  return {
    tick: snapshot.debug.tickCount,
    bots: snapshot.bots.map(toWireBot),
    dots: snapshot.dots.map(toWireDot),
    mines: snapshot.mines.map(toWireMine),
    coverages: snapshot.coverages.map(toWireCoverage),
    noises: snapshot.noises.map(toWireNoise),
  };
}

export function toViewerSnapshot(
  wire: FullWireSnapshot,
  ack: number,
  dots: { deltas?: WireDotDelta[]; sync?: WireDotContextSync[] } = {},
): WireSnapshot {
  return {
    tick: wire.tick,
    ack,
    bots: wire.bots,
    ...(dots.deltas?.length ? { dotDeltas: dots.deltas } : {}),
    ...(dots.sync?.length ? { dotSync: dots.sync } : {}),
    ...(wire.mines.length ? { mines: wire.mines } : {}),
    ...(wire.coverages.length ? { coverages: wire.coverages } : {}),
    ...(wire.noises.length ? { noises: wire.noises } : {}),
    ...(wire.intel === undefined ? {} : { intel: wire.intel }),
  };
}

export function toWireDot(dot: DotEntity): WireDot {
  return {
    id: dot.id,
    position: { x: roundPosition(dot.position.x), y: roundPosition(dot.position.y) },
    radius: roundFloat(dot.radius),
    floorId: dot.floorId,
    it: itemToCode(dot.item),
    active: dot.active,
    ...(dot.captureProgressMs === 0 ? {} : { captureProgressMs: roundMs(dot.captureProgressMs) }),
  };
}

export function applyWireDotFrame(
  store: Map<string, WireDot>,
  frame: Pick<WireSnapshot, "dotDeltas" | "dotSync">,
  contextForFloor: (floorId: string) => string,
): void {
  for (const sync of frame.dotSync ?? []) {
    for (const [id, dot] of store) {
      if (contextForFloor(dot.floorId) === sync.context) store.delete(id);
    }
    for (const dot of sync.dots ?? []) store.set(dot.id, { ...dot, position: { ...dot.position } });
  }
  for (const delta of frame.dotDeltas ?? []) {
    const dot = store.get(delta.id);
    if (!dot) continue;
    store.set(delta.id, {
      ...dot,
      ...(delta.active === undefined ? {} : { active: delta.active }),
      ...(delta.captureProgressMs === undefined
        ? {}
        : { captureProgressMs: delta.captureProgressMs === 0 ? undefined : delta.captureProgressMs }),
    });
  }
}

function toWireBot(bot: DotBotEntity): WireBot {
  const wire: WireBot = {
    i: bot.id,
    p: [roundPosition(bot.position.x), roundPosition(bot.position.y)],
  };

  const bays = bot.bays.map((item) => item ? itemToCode(item) : null);
  if (bot.facing !== 0) wire.f = roundFloat(bot.facing);
  if (bot.floorId !== OUTDOOR_FLOOR_ID) wire.fl = bot.floorId;
  if (bot.state !== "alive") wire.s = bot.state;
  if (bot.shieldSegments.some((segment) => segment !== 1)) wire.sh = bot.shieldSegments.map(roundFloat);
  if (bays.some((item) => item !== null)) wire.b = bays;
  if (bot.hold.length) wire.h = bot.hold.map(itemToCode);
  if (bot.carriedCount !== 0) wire.c = bot.carriedCount;

  if (bot.dashCooldownMs !== 0 || bot.dashActiveMs !== 0) {
    wire.d = [roundMs(bot.dashCooldownMs), roundMs(bot.dashActiveMs)];
  }
  if (bot.invulnerabilityMs !== 0) {
    wire.iv = roundMs(bot.invulnerabilityMs);
  }
  if (bot.radarActiveMs !== 0 || bot.radarPings.length > 0) {
    const pings = bot.radarPings.map(toWireRadarPing);
    wire.r = pings.length ? [roundMs(bot.radarActiveMs), pings] : [roundMs(bot.radarActiveMs)];
  }
  if (bot.dashOverchargeCharges !== 0) wire.o = bot.dashOverchargeCharges;
  if (bot.incognitoMs !== 0) wire.ic = roundMs(bot.incognitoMs);
  return wire;
}

export function fromWireSnapshot(
  wire: WireSnapshot,
  metaIndex: ReadonlyMap<string, EntityMeta>,
  dots: readonly WireDot[],
): GameSnapshot {
  return {
    timeMs: wire.tick * (1000 / 60),
    bots: wire.bots.map((bot) => fromWireBot(bot, metaIndex)),
    dots: dots.map(({ it, captureProgressMs = 0, ...dot }) => ({ ...dot, captureProgressMs, item: itemFromCode(it) })),
    mines: (wire.mines ?? []).map((mine) => ({
      ...mine,
      position: { ...mine.position },
      placedByBotId: mine.placedByBotId ?? "",
      squadId: mine.squadId ?? "",
      revealedToBotIds: [...(mine.revealedToBotIds ?? [])],
    })),
    coverages: wire.coverages ?? [],
    noises: wire.noises ?? [],
    debug: {
      tickHz: 60,
      tickCount: wire.tick,
      fps: 0,
      activeBodies: wire.bots.filter((bot) => bot.s !== "consumed").length,
      activeDots: dots.filter((dot) => dot.active).length,
    },
  };
}

function fromWireBot(bot: WireBot, metaIndex: ReadonlyMap<string, EntityMeta>): DotBotEntity {
  const meta = metaIndex.get(bot.i);
  if (!meta) {
    throw new Error(`Missing entity metadata for ${bot.i}`);
  }
  const shieldSegments = bot.sh ? [...bot.sh] : Array(meta.maxShields).fill(1);
  return {
    id: meta.id,
    name: meta.name,
    squadId: meta.squadId,
    isAmbient: meta.isAmbient,
    color: meta.color ?? "#111111",
    radius: meta.radius,
    maxShields: meta.maxShields,
    position: { x: bot.p[0], y: bot.p[1] },
    facing: bot.f ?? 0,
    floorId: bot.fl ?? OUTDOOR_FLOOR_ID,
    state: bot.s ?? "alive",
    shieldSegments,
    shields: shieldSegments.reduce((sum, segment) => sum + segment, 0),
    bays: (bot.b ?? [null, null, null, null]).map((code) => code ? itemFromCode(code) : null),
    hold: (bot.h ?? []).map(itemFromCode),
    carriedCount: bot.c ?? 0,
    dashCooldownMs: bot.d?.[0] ?? 0,
    dashActiveMs: bot.d?.[1] ?? 0,
    invulnerabilityMs: bot.iv ?? 0,
    radarActiveMs: bot.r?.[0] ?? 0,
    radarPings: bot.r?.[1]?.map((ping) => ({ ...ping })) ?? [],
    dashOverchargeCharges: bot.o ?? 0,
    incognitoMs: bot.ic ?? 0,
  };
}

function toWireMine(mine: MineEntity): WireMine {
  return {
    id: mine.id,
    position: { x: roundPosition(mine.position.x), y: roundPosition(mine.position.y) },
    radius: roundFloat(mine.radius),
    floorId: mine.floorId,
    placedAtMs: roundMs(mine.placedAtMs),
    placedByBotId: mine.placedByBotId,
    squadId: mine.squadId,
    ...(mine.revealedToBotIds.length ? { revealedToBotIds: [...mine.revealedToBotIds] } : {}),
  };
}

function toWireCoverage(coverage: CoverageSnapshot): CoverageSnapshot {
  return { ...coverage, progressMs: roundMs(coverage.progressMs), durationMs: roundMs(coverage.durationMs) };
}

function toWireNoise(noise: NoiseEvent): NoiseEvent {
  return {
    ...noise,
    position: { x: roundPosition(noise.position.x), y: roundPosition(noise.position.y) },
    loudness: roundFloat(noise.loudness),
    ageMs: roundMs(noise.ageMs),
    ttlMs: roundMs(noise.ttlMs),
  };
}

function toWireRadarPing(ping: RadarPing): RadarPing {
  return { x: roundPosition(ping.x), y: roundPosition(ping.y), ageMs: roundMs(ping.ageMs) };
}

export function toWireEvent(event: SimEvent): WireSimEvent {
  if (event.type === "consumed") return { ...event, lostItems: event.lostItems.map(itemToCode) };
  if (event.type === "extracted") return { ...event, items: event.items.map(itemToCode) };
  return event;
}

export function fromWireEvent(event: WireSimEvent): SimEvent {
  if (event.type === "consumed") return { ...event, lostItems: event.lostItems.map(itemFromCode) };
  if (event.type === "extracted") return { ...event, items: event.items.map(itemFromCode) };
  return event;
}
