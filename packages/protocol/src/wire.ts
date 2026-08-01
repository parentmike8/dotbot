import { defaultGameConfig } from "@dotbot/game/config";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import type { DotBotEntity, DotEntity, GameSnapshot, MineEntity, NoiseEvent, CoverageSnapshot, RadarContact } from "@dotbot/game/types";
import type { SimEvent } from "@dotbot/game/types";
import type { EntityMeta, FullWireSnapshot, KillCamActor, KillCamClip, WireBot, WireDot, WireDotContextSync, WireDotDelta, WireKillCamActor, WireKillCamClip, WireMine, WireSnapshot } from "./messages";
import type { WireSimEvent } from "./messages";
import { itemFromCode, itemToCode } from "./items";

const roundPosition = (value: number) => Math.round(value * 100) / 100;
const roundFloat = (value: number) => Math.round(value * 100) / 100;
const roundMs = (value: number) => Math.round(value);

const killCamCauseCodes = ["dash", "ram", "mine", "environment"] as const;

export function toWireKillCamClip(clip: KillCamClip): WireKillCamClip {
  const causeCode = killCamCauseCodes.indexOf(clip.cause.kind);
  return {
    i: clip.id,
    v: clip.victimId,
    ...(clip.sourceBotId ? { s: clip.sourceBotId } : {}),
    c: [
      causeCode as 0 | 1 | 2 | 3,
      clip.cause.tick,
      roundPosition(clip.cause.position.x),
      roundPosition(clip.cause.position.y),
      roundFloat(clip.cause.direction.x),
      roundFloat(clip.cause.direction.y),
    ],
    a: clip.startTick,
    z: clip.deathTick,
    h: clip.tickHz,
    ...(clip.impacts?.length ? {
      p: clip.impacts.map((impact) => ([
        impact.tick,
        impact.result === "plateBreak" ? 0 : 1,
        roundPosition(impact.position.x),
        roundPosition(impact.position.y),
        roundFloat(impact.direction.x),
        roundFloat(impact.direction.y),
        ...(impact.sourceId ? [impact.sourceId] : []),
      ] as [number, 0 | 1, number, number, number, number, string?])),
    } : {}),
    f: clip.frames.map((frame) => {
      const wireFrame: import("./messages").WireKillCamFrame = [
        frame.tick,
        toWireKillCamActor(frame.victim),
        frame.source ? toWireKillCamActor(frame.source) : null,
      ];
      if (frame.blockingDoorIds.length) wireFrame[3] = frame.blockingDoorIds;
      if (frame.visibleBots.length) {
        // JSON encodes a sparse tuple slot as null. Fill the optional doorway
        // slot before appending visible actors so the serialized wire frame
        // remains decodable by both current and rolling clients.
        wireFrame[3] ??= [];
        wireFrame[4] = frame.visibleBots.map(toWireKillCamActor);
      }
      return wireFrame;
    }),
  };
}

export function fromWireKillCamClip(wire: WireKillCamClip): KillCamClip {
  const [kind, tick, x, y, dx, dy] = wire.c;
  return {
    id: wire.i,
    victimId: wire.v,
    ...(wire.s ? { sourceBotId: wire.s } : {}),
    cause: {
      kind: killCamCauseCodes[kind],
      tick,
      position: { x, y },
      direction: { x: dx, y: dy },
    },
    startTick: wire.a,
    deathTick: wire.z,
    tickHz: wire.h,
    ...(wire.p ? {
      impacts: wire.p.map(([impactTick, result, px, py, pdx, pdy, sourceId]) => ({
        tick: impactTick,
        result: result === 0 ? "plateBreak" as const : "downed" as const,
        position: { x: px, y: py },
        direction: { x: pdx, y: pdy },
        ...(sourceId ? { sourceId } : {}),
      })),
    } : {}),
    frames: wire.f.map(([frameTick, victim, source, blockingDoorIds, visibleBots]) => ({
      tick: frameTick,
      victim: fromWireKillCamActor(victim),
      ...(source ? { source: fromWireKillCamActor(source) } : {}),
      visibleBots: (visibleBots ?? []).map(fromWireKillCamActor),
      blockingDoorIds: [...(blockingDoorIds ?? [])],
    })),
  };
}

function toWireKillCamActor(actor: KillCamActor): WireKillCamActor {
  const wire: WireKillCamActor = [
    actor.id,
    roundPosition(actor.position.x),
    roundPosition(actor.position.y),
    roundFloat(actor.facing),
    actor.floorId,
    actor.shieldSegments.map(roundFloat),
    roundMs(actor.dashActiveMs),
  ];
  if (actor.state === "downed") wire[7] = 1;
  return wire;
}

function fromWireKillCamActor(actor: WireKillCamActor): KillCamActor {
  const [id, x, y, facing, floorId, shieldSegments, dashActiveMs, downed] = actor;
  return {
    id,
    position: { x, y },
    facing,
    floorId,
    shieldSegments: [...shieldSegments],
    dashActiveMs,
    state: downed ? "downed" : "alive",
  };
}

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
    doors: (snapshot.doors ?? []).map((door) => ({
      ...door,
      position: { x: roundPosition(door.position.x), y: roundPosition(door.position.y) },
      openness: roundFloat(door.openness),
    })),
    ...(snapshot.rivalsAlive === undefined ? {} : { rivalsAlive: snapshot.rivalsAlive }),
  };
}

export function toViewerSnapshot(
  wire: FullWireSnapshot,
  ack: number,
  dots: { deltas?: WireDotDelta[]; adds?: WireDot[]; runtimeDots?: WireDot[]; sync?: WireDotContextSync[] } = {},
): WireSnapshot {
  return {
    tick: wire.tick,
    ack,
    bots: wire.bots,
    ...(dots.deltas?.length ? { dotDeltas: dots.deltas } : {}),
    ...(dots.adds?.length ? { dotAdds: dots.adds } : {}),
    ...(dots.runtimeDots ? { runtimeDots: dots.runtimeDots } : {}),
    ...(dots.sync?.length ? { dotSync: dots.sync } : {}),
    ...(wire.mines.length ? { mines: wire.mines } : {}),
    ...(wire.coverages.length ? { coverages: wire.coverages } : {}),
    ...(wire.noises.length ? { noises: wire.noises } : {}),
    ...(wire.doors?.length ? { doors: wire.doors } : {}),
    ...(wire.rivalsAlive === undefined ? {} : { rivalsAlive: wire.rivalsAlive }),
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
    ...(dot.item.sourceBuildingId ? { src: dot.item.sourceBuildingId } : {}),
    ...(dot.runtime ? { rt: true } : {}),
    active: dot.active,
    ...(dot.captureProgressMs === 0 ? {} : { captureProgressMs: roundMs(dot.captureProgressMs) }),
  };
}

export function applyWireDotFrame(
  store: Map<string, WireDot>,
  frame: Pick<WireSnapshot, "dotDeltas" | "dotAdds" | "runtimeDots" | "dotSync">,
  contextForFloor: (floorId: string) => string,
): void {
  for (const sync of frame.dotSync ?? []) {
    for (const [id, dot] of store) {
      if (contextForFloor(dot.floorId) === sync.context) store.delete(id);
    }
    for (const dot of sync.dots ?? []) store.set(dot.id, { ...dot, position: { ...dot.position } });
  }
  for (const dot of frame.dotAdds ?? []) {
    store.set(dot.id, { ...dot, position: { ...dot.position } });
  }
  // Context replacement can delete every definition on an affected floor.
  // Apply the complete runtime set last so one latest-state frame is atomic:
  // it is safe even when the following snapshot is lost.
  if (frame.runtimeDots !== undefined) {
    for (const [id, dot] of store) {
      if (dot.rt) store.delete(id);
    }
    for (const dot of frame.runtimeDots) {
      store.set(dot.id, { ...dot, rt: true, position: { ...dot.position } });
    }
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
  const baySources = bot.bays.map((item) => item?.sourceBuildingId ?? null);
  if (bot.facing !== 0) wire.f = roundFloat(bot.facing);
  if (bot.floorId !== OUTDOOR_FLOOR_ID) wire.fl = bot.floorId;
  if (bot.state !== "alive") wire.s = bot.state;
  if (bot.shieldSegments.some((segment) => segment !== 1)) wire.sh = bot.shieldSegments.map(roundFloat);
  if (bot.moving) wire.mv = true;
  if (bays.some((item) => item !== null)) wire.b = bays;
  if (bot.hold.length) wire.h = bot.hold.map(itemToCode);
  if (baySources.some(Boolean)) wire.bs = baySources;
  const holdSources = bot.hold.map((item) => item.sourceBuildingId ?? null);
  if (holdSources.some(Boolean)) wire.hs = holdSources;
  if ((bot.inventoryRevision ?? 0) !== 0) wire.ir = bot.inventoryRevision;
  if (bot.carriedCount !== 0) wire.c = bot.carriedCount;
  if (bot.searched) wire.sr = true;
  if (bot.pleaded) wire.pl = true;

  if (bot.dashCooldownMs !== 0 || bot.dashActiveMs !== 0) {
    // Dash timers keep centi-ms precision: reconciliation replays the dash
    // from these values, and whole-ms rounding flips the dash-end boundary
    // by a tick (~7px of divergence — a visible correction every dash).
    wire.d = [roundFloat(bot.dashCooldownMs), roundFloat(bot.dashActiveMs)];
  }
  if (bot.invulnerabilityMs !== 0) {
    wire.iv = roundMs(bot.invulnerabilityMs);
  }
  if (bot.radarActiveMs !== 0 || bot.radarPings.length > 0) {
    const pings = bot.radarPings.map(toWireRadarContact);
    wire.r = pings.length ? [roundMs(bot.radarActiveMs), pings] : [roundMs(bot.radarActiveMs)];
  }
  if (bot.dashOverchargeMs !== 0) wire.o = roundMs(bot.dashOverchargeMs);
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
    dots: dots.map(({ it, src, rt, captureProgressMs = 0, ...dot }) => ({
      ...dot,
      captureProgressMs,
      item: itemWithSource(it, src),
      ...(rt ? { runtime: true as const } : {}),
    })),
    mines: (wire.mines ?? []).map((mine) => ({
      ...mine,
      position: { ...mine.position },
      placedByBotId: mine.placedByBotId ?? "",
      squadId: mine.squadId ?? "",
      revealedToBotIds: [...(mine.revealedToBotIds ?? [])],
    })),
    coverages: wire.coverages ?? [],
    noises: wire.noises ?? [],
    doors: (wire.doors ?? []).map((door) => ({ ...door, position: { ...door.position } })),
    ...(wire.rivalsAlive === undefined ? {} : { rivalsAlive: wire.rivalsAlive }),
    debug: {
      tickHz: 60,
      tickCount: wire.tick,
      fps: 0,
      activeBodies: wire.bots.length,
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
    moving: bot.mv === true,
    floorId: bot.fl ?? OUTDOOR_FLOOR_ID,
    state: bot.s ?? "alive",
    shieldSegments,
    shields: shieldSegments.reduce((sum, segment) => sum + segment, 0),
    // `b` is omitted when every bay is empty, so its absence still has a length.
    bays: (bot.b ?? Array.from({ length: defaultGameConfig.baySlots }, () => null))
      .map((code, index) => code ? itemWithSource(code, bot.bs?.[index] ?? undefined) : null),
    hold: (bot.h ?? []).map((code, index) => itemWithSource(code, bot.hs?.[index] ?? undefined)),
    inventoryRevision: bot.ir ?? 0,
    carriedCount: bot.c ?? 0,
    searched: bot.sr === true,
    pleaded: bot.pl === true,
    dashCooldownMs: bot.d?.[0] ?? 0,
    dashActiveMs: bot.d?.[1] ?? 0,
    invulnerabilityMs: bot.iv ?? 0,
    radarActiveMs: bot.r?.[0] ?? 0,
    radarPings: bot.r?.[1]?.map(fromWireRadarContact) ?? [],
    dashOverchargeMs: bot.o ?? 0,
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

function toWireRadarContact(contact: RadarContact): import("./messages").WireRadarContact {
  return [
    contact.botId,
    roundPosition(contact.x),
    roundPosition(contact.y),
    contact.floorId,
    roundMs(contact.ageMs),
  ];
}

function fromWireRadarContact(
  [botId, x, y, floorId, ageMs]: import("./messages").WireRadarContact,
): RadarContact {
  return { botId, x, y, floorId, ageMs };
}

export function toWireEvent(event: SimEvent): WireSimEvent {
  if (event.type === "looted" || event.type === "extracted") {
    const itemSources = event.items.map((item) => item.sourceBuildingId ?? null);
    return {
      ...event,
      items: event.items.map(itemToCode),
      ...(itemSources.some(Boolean) ? { itemSources } : {}),
    };
  }
  return event;
}

export function fromWireEvent(event: WireSimEvent): SimEvent {
  if (event.type === "hit") {
    return {
      ...event,
      result: event.result ?? "plateBreak",
      position: event.position ?? { x: 0, y: 0 },
      direction: event.direction ?? { x: 0, y: 0 },
      tick: event.tick ?? 0,
    };
  }
  if (event.type === "looted" || event.type === "extracted") {
    const { itemSources, ...rest } = event;
    return {
      ...rest,
      items: event.items.map((code, index) => itemWithSource(code, itemSources?.[index] ?? undefined)),
    };
  }
  return event;
}

function itemWithSource(code: import("./items").WireItemCode, sourceBuildingId?: string): import("@dotbot/game/types").Item {
  const item = itemFromCode(code);
  return sourceBuildingId ? { ...item, sourceBuildingId } : item;
}
