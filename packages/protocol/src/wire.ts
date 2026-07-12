import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import type { EntityMeta, WireBot, WireSnapshot } from "./messages";

const roundPosition = (value: number) => Math.round(value * 100) / 100;
const roundFacing = (value: number) => Math.round(value * 1000) / 1000;

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

export function toWireSnapshot(snapshot: GameSnapshot, ack = 0): WireSnapshot {
  return {
    tick: snapshot.debug.tickCount,
    ack,
    bots: snapshot.bots.map(toWireBot),
    dots: snapshot.dots,
    coverages: snapshot.coverages,
    noises: snapshot.noises,
  };
}

function toWireBot(bot: DotBotEntity): WireBot {
  const wire: WireBot = {
    i: bot.id,
    p: [roundPosition(bot.position.x), roundPosition(bot.position.y)],
    f: roundFacing(bot.facing),
    fl: bot.floorId,
    s: bot.state,
    sh: bot.shieldSegments,
    b: bot.bays,
    h: bot.hold,
  };

  if (bot.dashCooldownMs !== 0 || bot.dashActiveMs !== 0) {
    wire.d = [bot.dashCooldownMs, bot.dashActiveMs];
  }
  if (bot.invulnerabilityMs !== 0) {
    wire.iv = bot.invulnerabilityMs;
  }
  if (bot.radarActiveMs !== 0 || bot.radarPings.length > 0) wire.r = [bot.radarActiveMs, bot.radarPings];
  if (bot.dashOverchargeCharges !== 0) wire.o = bot.dashOverchargeCharges;
  if (bot.incognitoMs !== 0) wire.ic = bot.incognitoMs;
  return wire;
}

export function fromWireSnapshot(wire: WireSnapshot, metaIndex: ReadonlyMap<string, EntityMeta>): GameSnapshot {
  return {
    timeMs: wire.tick * (1000 / 60),
    bots: wire.bots.map((bot) => fromWireBot(bot, metaIndex)),
    dots: wire.dots,
    coverages: wire.coverages,
    noises: wire.noises,
    debug: {
      tickHz: 60,
      tickCount: wire.tick,
      fps: 0,
      activeBodies: wire.bots.filter((bot) => bot.s !== "consumed").length,
      activeDots: wire.dots.filter((dot) => dot.active).length,
    },
  };
}

function fromWireBot(bot: WireBot, metaIndex: ReadonlyMap<string, EntityMeta>): DotBotEntity {
  const meta = metaIndex.get(bot.i);
  if (!meta) {
    throw new Error(`Missing entity metadata for ${bot.i}`);
  }
  const shieldSegments = [...bot.sh];
  return {
    id: meta.id,
    name: meta.name,
    squadId: meta.squadId,
    isAmbient: meta.isAmbient,
    color: meta.color ?? "#111111",
    radius: meta.radius,
    maxShields: meta.maxShields,
    position: { x: bot.p[0], y: bot.p[1] },
    facing: bot.f,
    floorId: bot.fl,
    state: bot.s,
    shieldSegments,
    shields: shieldSegments.reduce((sum, segment) => sum + segment, 0),
    bays: bot.b.map((item) => item && { ...item }),
    hold: bot.h.map((item) => ({ ...item })),
    dashCooldownMs: bot.d?.[0] ?? 0,
    dashActiveMs: bot.d?.[1] ?? 0,
    invulnerabilityMs: bot.iv ?? 0,
    radarActiveMs: bot.r?.[0] ?? 0,
    radarPings: bot.r?.[1]?.map((ping) => ({ ...ping })) ?? [],
    dashOverchargeCharges: bot.o ?? 0,
    incognitoMs: bot.ic ?? 0,
  };
}
