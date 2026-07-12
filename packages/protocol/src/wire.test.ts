import { describe, expect, it } from "vitest";
import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import type { ClientMessage, ServerMessage } from "./messages";
import { assertNever } from "./messages";
import { fromWireSnapshot, toEntityMeta, toWireSnapshot } from "./wire";

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
  coverages: [],
  noises: [],
  debug: { tickHz: 60, tickCount: 12, fps: 60, activeBodies: 1, activeDots: 1 },
};

describe("snapshot wire mapping", () => {
  it("round-trips entity dynamics through JSON with bounded rounding", () => {
    const decoded = JSON.parse(JSON.stringify(toWireSnapshot(snapshot, 7)));
    const restored = fromWireSnapshot(decoded, new Map([[bot.id, toEntityMeta(bot)]]));
    const restoredBot = restored.bots[0];

    expect(Math.abs(restoredBot.position.x - bot.position.x)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(restoredBot.position.y - bot.position.y)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(restoredBot.facing - bot.facing)).toBeLessThanOrEqual(0.0005);
    expect(restoredBot).toMatchObject({
      id: bot.id,
      name: bot.name,
      color: bot.color,
      shieldSegments: bot.shieldSegments,
      bays: bot.bays,
      hold: bot.hold,
      dashCooldownMs: bot.dashCooldownMs,
      dashActiveMs: bot.dashActiveMs,
      invulnerabilityMs: bot.invulnerabilityMs,
    });
  });
});

function exhaustClient(message: ClientMessage): string {
  switch (message.type) {
    case "hello": return message.token;
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
