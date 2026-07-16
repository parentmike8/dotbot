import { describe, expect, it } from "vitest";
import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import type { ClientMessage, ServerMessage, WireDot } from "./messages";
import { assertNever } from "./messages";
import { applyWireDotFrame, fromWireSnapshot, toEntityMeta, toViewerSnapshot, toWireSnapshot } from "./wire";
import { itemFromCode, itemToCode } from "./items";

const bot: DotBotEntity = {
  id: "bot-a",
  name: "Ada",
  squadId: "alpha",
  isAmbient: false,
  color: "#123456",
  position: { x: 123.456, y: 987.654 },
  radius: 24,
  state: "alive",
  floorId: "outdoor",
  facing: 1.23456,
  maxShields: 3,
  shields: 2.5,
  shieldSegments: [1, 1, 0.5],
  bays: [{ kind: "powerup", type: "health" }, { kind: "powerup", type: "radar" }, null, null],
  hold: [],
  carriedCount: 2,
  radarActiveMs: 0,
  radarPings: [],
  dashOverchargeCharges: 0,
  incognitoMs: 0,
  dashCooldownMs: 312.5,
  dashActiveMs: 12.5,
  invulnerabilityMs: 88,
};

const snapshot: GameSnapshot = {
  timeMs: 200,
  bots: [bot],
  dots: [{
    id: "dot-a", item: { kind: "powerup", type: "radar" }, position: { x: 4, y: 5 }, radius: 10,
    floorId: "outdoor", active: true, captureProgressMs: 0,
  }],
  mines: [],
  coverages: [],
  noises: [],
  debug: { tickHz: 60, tickCount: 12, fps: 60, activeBodies: 1, activeDots: 1 },
};

describe("snapshot wire mapping", () => {
  it("round-trips entity dynamics through JSON with bounded rounding", () => {
    const full = toWireSnapshot(snapshot);
    const decoded = JSON.parse(JSON.stringify(toViewerSnapshot(full, 7)));
    const restored = fromWireSnapshot(decoded, new Map([[bot.id, toEntityMeta(bot)]]), full.dots);
    const restoredBot = restored.bots[0];

    expect(Math.abs(restoredBot.position.x - bot.position.x)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(restoredBot.position.y - bot.position.y)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(restoredBot.facing - bot.facing)).toBeLessThanOrEqual(0.005);
    expect(restoredBot).toMatchObject({
      id: bot.id,
      name: bot.name,
      color: bot.color,
      shieldSegments: bot.shieldSegments,
      bays: bot.bays,
      hold: bot.hold,
      // Centi-ms precision: reconciliation replays dashes from these values,
      // and whole-ms rounding flips the dash-end tick (~7px correction).
      dashCooldownMs: Math.round(bot.dashCooldownMs * 100) / 100,
      dashActiveMs: Math.round(bot.dashActiveMs * 100) / 100,
      invulnerabilityMs: Math.round(bot.invulnerabilityMs),
    });
  });

  it("omits empty collections and default bot fields while preserving round-trip defaults", () => {
    const defaultBot = {
      ...bot,
      facing: 0,
      floorId: "outdoor",
      shieldSegments: [1, 1, 1],
      shields: 3,
      bays: [null, null, null, null],
      carriedCount: 0,
      dashCooldownMs: 0,
      dashActiveMs: 0,
      invulnerabilityMs: 0,
    } satisfies DotBotEntity;
    const full = toWireSnapshot({ ...snapshot, bots: [defaultBot], dots: [], mines: [], coverages: [], noises: [] });
    const payload = toViewerSnapshot(full, 0);
    expect(payload).not.toHaveProperty("dotDeltas");
    expect(payload).not.toHaveProperty("dotSync");
    expect(payload).not.toHaveProperty("mines");
    expect(payload).not.toHaveProperty("coverages");
    expect(payload).not.toHaveProperty("noises");
    expect(payload.bots[0]).toEqual({ i: defaultBot.id, p: [123.46, 987.65] });
    expect(fromWireSnapshot(payload, new Map([[defaultBot.id, toEntityMeta(defaultBot)]]), []).bots[0]).toMatchObject({
      facing: 0,
      floorId: "outdoor",
      state: "alive",
      shieldSegments: [1, 1, 1],
      bays: [null, null, null, null],
      carriedCount: 0,
    });
  });

  it("reconstructs randomized dot state exactly from ordered deltas", () => {
    let seed = 0x1a2b3c4d;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const makeDot = (id: string): WireDot => ({
      id,
      position: { x: Number(id.slice(1)), y: 2 },
      radius: 10,
      floorId: "outdoor",
      it: "h",
      active: true,
    });
    const authoritative = new Map(Array.from({ length: 20 }, (_, index) => {
      const dot = makeDot(`d${index}`);
      return [dot.id, dot] as const;
    }));
    const reconstructed = new Map([...authoritative].map(([id, dot]) => [id, { ...dot, position: { ...dot.position } }]));

    for (let step = 0; step < 500; step += 1) {
      const id = `d${Math.floor(random() * authoritative.size)}`;
      const before = authoritative.get(id)!;
      const active = random() > 0.08 ? before.active : !before.active;
      const captureProgressMs = active ? Math.floor(random() * 1001) : 0;
      authoritative.set(id, { ...before, active, captureProgressMs: captureProgressMs || undefined });
      applyWireDotFrame(reconstructed, {
        dotDeltas: [{ id, ...(active === before.active ? {} : { active }), captureProgressMs }],
      }, () => "outdoor");
      expect([...reconstructed.values()]).toEqual([...authoritative.values()]);
    }
  });

  it("replaces changed floor contexts wholesale without retaining hidden dots", () => {
    const outside: WireDot = { id: "outside", position: { x: 1, y: 1 }, radius: 10, floorId: "outdoor", it: "h", active: true };
    const upper: WireDot = { id: "upper", position: { x: 2, y: 2 }, radius: 10, floorId: "mercy:F1", it: "r", active: false };
    const store = new Map([[outside.id, outside]]);
    applyWireDotFrame(store, {
      dotSync: [{ context: "outdoor" }, { context: "mercy:F1", dots: [upper] }],
    }, (floorId) => floorId);
    expect([...store.values()]).toEqual([upper]);
  });
});

describe("compact item codes", () => {
  it("round-trips every powerup and a blueprint id", () => {
    const items = [
      { kind: "powerup", type: "health" },
      { kind: "powerup", type: "radar" },
      { kind: "powerup", type: "dashOvercharge" },
      { kind: "powerup", type: "incognito" },
      { kind: "mine" },
      { kind: "blueprint", blueprintId: "serverRack" },
    ] as const;
    expect(items.map(itemToCode)).toEqual(["h", "r", "d", "i", "m", "b:serverRack"]);
    expect(items.map(itemToCode).map(itemFromCode)).toEqual(items);
  });
});

function exhaustClient(message: ClientMessage): string {
  switch (message.type) {
    case "hello": return message.token;
    case "joinSquad": return message.squadId;
    case "startMatch": return message.type;
    case "leaveRun": return message.type;
    case "input": return String(message.seq);
    case "ping": return String(message.cts);
    default: return assertNever(message);
  }
}

function exhaustServer(message: ServerMessage): string {
  switch (message.type) {
    case "welcome": return message.playerId;
    case "lobby": return message.hostId;
    case "matchStart": return message.yourBotId;
    case "snap": return String(message.tick);
    case "meta": return String(message.add.length);
    case "ev": return String(message.events.length);
    case "runOver": return message.reason;
    case "matchEnd": return message.reason;
    case "pong": return String(message.sts);
    case "err": return message.code;
    default: return assertNever(message);
  }
}

describe("message exhaustiveness", () => {
  it("covers every discriminant", () => {
    expect(exhaustClient({ type: "startMatch" })).toBe("startMatch");
    expect(exhaustServer({ type: "err", code: "bad", msg: "bad" })).toBe("bad");
  });
});
