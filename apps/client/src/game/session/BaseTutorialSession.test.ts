import { describe, expect, it } from "vitest";
import {
  BASE_TUTORIAL_FABRICATOR_ID,
  BASE_TUTORIAL_TARGET_ID,
} from "@dotbot/game/baseTutorial";
import { createBaseMap, starterBaseLayout } from "@dotbot/game/content/base";
import type { GameSnapshot, InputCommand } from "@dotbot/game/types";
import {
  BaseTutorialSession,
  type BaseTutorialConnectionFactory,
} from "./BaseTutorialSession";

const idle: InputCommand = { move: { x: 0, y: 0 }, dash: false };

describe("BaseTutorialSession authority", () => {
  it("renders the server snapshot and freezes position and interaction input while disconnected", async () => {
    const map = createBaseMap(starterBaseLayout, "workshop", {
      tutorial: { phase: "movement", revision: 0 },
    });
    const sent: Array<{ input: InputCommand; interact: boolean }> = [];
    let callbacks!: Parameters<BaseTutorialConnectionFactory>[1];
    const session = new BaseTutorialSession({
      map,
      token: "owner-token",
      interactionIntent: () => true,
      onState() {},
      onConnectionState() {},
      onError() {},
      createConnection: (_token, next) => {
        callbacks = next;
        return {
          start() {},
          sendInput(input, interact) { sent.push({ input, interact }); },
          dispose() {},
        };
      },
    });
    await session.start();

    const authoritative = snapshot(4_200, { x: 318, y: 571 }, "downed", true);
    callbacks.onConnectionState("connected");
    callbacks.onState({
      tutorial: { phase: "fabricator", revision: 2 },
      playerPosition: { x: 318, y: 571 },
      inputAck: 27,
      fabricatorEnabled: true,
      snapshot: authoritative,
    });

    expect(session.update(16)).toBe(authoritative);
    expect(session.update(16)?.bots.find((bot) => bot.id === "player")?.position)
      .toEqual({ x: 318, y: 571 });
    expect(map.buildings[0].floors[0].objects.find((object) => object.id === BASE_TUTORIAL_FABRICATOR_ID)?.enabled)
      .toBe(true);
    session.sendInput(idle);
    expect(sent).toEqual([{ input: idle, interact: true }]);

    callbacks.onConnectionState("disconnected");
    session.sendInput({ move: { x: 1, y: 0 }, dash: true });
    expect(sent).toHaveLength(1);
    expect(session.update(5_000)).toBe(authoritative);
    expect(session.update(5_000)?.timeMs).toBe(4_200);
  });

  it("applies reconnect state without recreating the map or losing target and door dynamics", async () => {
    const map = createBaseMap(starterBaseLayout, "workshop", {
      tutorial: { phase: "practice", revision: 1 },
    });
    let callbacks!: Parameters<BaseTutorialConnectionFactory>[1];
    const session = new BaseTutorialSession({
      map,
      token: "owner-token",
      interactionIntent: () => false,
      onState() {},
      onConnectionState() {},
      onError() {},
      createConnection: (_token, next) => {
        callbacks = next;
        return { start() {}, sendInput() {}, dispose() {} };
      },
    });
    await session.start();
    const mapIdentity = session.map;

    callbacks.onConnectionState("connected");
    callbacks.onState({
      tutorial: { phase: "doorOpen", revision: 3 },
      playerPosition: { x: 401, y: 529 },
      inputAck: 44,
      fabricatorEnabled: true,
      snapshot: snapshot(7_000, { x: 401, y: 529 }, "downed", false),
    });
    callbacks.onConnectionState("disconnected");
    callbacks.onConnectionState("connected");
    const resumed = snapshot(7_000, { x: 401, y: 529 }, "downed", false);
    callbacks.onState({
      tutorial: { phase: "doorOpen", revision: 3 },
      playerPosition: { x: 401, y: 529 },
      inputAck: 44,
      fabricatorEnabled: true,
      snapshot: resumed,
    });

    expect(session.map).toBe(mapIdentity);
    expect(session.update(16)).toBe(resumed);
    expect(session.update(16)?.bots.find((bot) => bot.id === BASE_TUTORIAL_TARGET_ID)?.state).toBe("downed");
    expect(session.update(16)?.doors?.find((door) => door.doorwayId === "base-intro-door")?.blocking).toBe(false);
  });

  it("retires its grace-period connection exactly once after durable completion", async () => {
    const map = createBaseMap(starterBaseLayout, "workshop", {
      tutorial: { phase: "doorOpen", revision: 3 },
    });
    let callbacks!: Parameters<BaseTutorialConnectionFactory>[1];
    let disposals = 0;
    const session = new BaseTutorialSession({
      map,
      token: "owner-token",
      interactionIntent: () => false,
      onState() {},
      onConnectionState() {},
      onError() {},
      createConnection: (_token, next) => {
        callbacks = next;
        return {
          start() {},
          sendInput() {},
          dispose() { disposals += 1; },
        };
      },
    });
    await session.start();
    callbacks.onConnectionState("connected");
    callbacks.onState({
      tutorial: { phase: "complete", revision: 4 },
      playerPosition: { x: 302, y: 487 },
      inputAck: 61,
      fabricatorEnabled: false,
      snapshot: snapshot(9_000, { x: 302, y: 487 }, "downed", false),
    });

    expect(session.update(16)?.bots.find((bot) => bot.id === "player")?.position)
      .toEqual({ x: 302, y: 487 });
    expect(disposals).toBe(1);
    session.sendInput({ move: { x: 1, y: 0 }, dash: true });
    session.dispose();
    expect(disposals).toBe(1);
  });
});

function snapshot(
  timeMs: number,
  playerPosition: { x: number; y: number },
  targetState: "alive" | "downed",
  doorBlocking: boolean,
): GameSnapshot {
  return {
    timeMs,
    bots: [
      {
        id: "player", name: "Player", squadId: "base", isAmbient: false, color: "#fff",
        position: playerPosition, radius: 24, state: "alive", floorId: "outdoor", facing: 0,
        moving: false, maxShields: 3, shields: 3, shieldSegments: [1, 1, 1], bays: [],
        hold: [], carriedCount: 0, searched: false, pleaded: false, radarActiveMs: 0,
        radarPings: [], dashOverchargeMs: 0, incognitoMs: 0, dashCooldownMs: 0,
        dashActiveMs: 0, invulnerabilityMs: 0,
      },
      {
        id: BASE_TUTORIAL_TARGET_ID, name: "Practice", squadId: "practice", isAmbient: true,
        color: "#777", position: { x: 260, y: 536 }, radius: 24, state: targetState,
        floorId: "outdoor", facing: 0, moving: false, maxShields: 1, shields: 0,
        shieldSegments: [0], bays: [], hold: [], carriedCount: 0, searched: false,
        pleaded: false, radarActiveMs: 0, radarPings: [], dashOverchargeMs: 0,
        incognitoMs: 0, dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
      },
    ],
    dots: [],
    mines: [],
    coverages: [],
    noises: [],
    doors: [{
      id: "player-base:GROUND:base-intro-door",
      doorwayId: "base-intro-door",
      buildingId: "player-base",
      floorId: "outdoor",
      position: { x: 260, y: 500 },
      width: 96,
      dir: "h",
      phase: doorBlocking ? "closed" : "open",
      openness: doorBlocking ? 0 : 1,
      blocking: doorBlocking,
    }],
    debug: { tickHz: 60, tickCount: Math.round(timeMs / (1000 / 60)), fps: 60, activeBodies: 2, activeDots: 0 },
  };
}
