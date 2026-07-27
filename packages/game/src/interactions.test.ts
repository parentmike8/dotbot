import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { bodyContentsPublic, canTakeFromBody } from "./interactions";
import type { DotBotEntity } from "./types";

/**
 * `canTakeFromBody` is the one rule three places read: the simulation gates takes
 * on it, the picker decides what to show from it, and the interest filter decides
 * what inventory crosses the wire from it. If it drifts, a player is offered a slot
 * the server will refuse — so every clause it makes is pinned here.
 */
const tolerance = defaultGameConfig.coverCenterTolerance;

function body(overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return {
    id: "body",
    name: "Body",
    squadId: "rival-1",
    isAmbient: false,
    color: "#111",
    position: { x: 100, y: 100 },
    radius: defaultGameConfig.botRadius,
    state: "downed",
    floorId: "outdoor",
    facing: 0,
    maxShields: 3,
    shields: 0,
    shieldSegments: [0, 0, 0],
    bays: [null, null, null],
    hold: [],
    carriedCount: 0,
    searched: true,
    radarActiveMs: 0,
    radarPings: [],
    dashOverchargeCharges: 0,
    incognitoMs: 0,
    dashCooldownMs: 0,
    dashActiveMs: 0,
    invulnerabilityMs: 0,
    ...overrides,
  };
}

function taker(overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return body({ id: "taker", squadId: "alpha", state: "alive", shields: 3, shieldSegments: [1, 1, 1], searched: false, ...overrides });
}

describe("canTakeFromBody", () => {
  it("opens a searched rival body underfoot", () => {
    expect(canTakeFromBody(taker(), body(), tolerance)).toBe(true);
  });

  it("stays shut until a loot channel has searched the body", () => {
    expect(canTakeFromBody(taker(), body({ searched: false }), tolerance)).toBe(false);
  });

  it("never opens a squadmate's body: you pick them up instead", () => {
    expect(canTakeFromBody(taker({ squadId: "alpha" }), body({ squadId: "alpha" }), tolerance)).toBe(false);
  });

  it("needs the body under your hands, not merely in the room", () => {
    // The channel's own reach, so the picker cannot offer what the channel could
    // not have started.
    const reach = defaultGameConfig.botRadius + defaultGameConfig.botRadius * 0.55;
    expect(canTakeFromBody(taker({ position: { x: 100 + reach - 1, y: 100 } }), body(), tolerance)).toBe(true);
    expect(canTakeFromBody(taker({ position: { x: 100 + reach + 1, y: 100 } }), body(), tolerance)).toBe(false);
  });

  it("does not reach through a floor", () => {
    expect(canTakeFromBody(taker({ floorId: "tower-2" }), body(), tolerance)).toBe(false);
  });

  it("refuses a downed taker, and refuses a bot reaching into itself", () => {
    expect(canTakeFromBody(taker({ state: "downed" }), body(), tolerance)).toBe(false);
    expect(canTakeFromBody(taker({ id: "body", squadId: "rival-1" }), body(), tolerance)).toBe(false);
  });

  it("treats an alive bot's inventory as private however it was searched", () => {
    // `searched` only ever means something while a bot is down. A revive clears it,
    // but nothing should depend on that clearing happening to stay private.
    expect(bodyContentsPublic(body({ state: "alive" }))).toBe(false);
    expect(canTakeFromBody(taker(), body({ state: "alive" }), tolerance)).toBe(false);
  });
});
