import { describe, expect, it } from "vitest";
import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import type { ClientMessage, KillCamClip, ServerMessage, WireDot } from "./messages";
import { assertNever } from "./messages";
import { applyWireDotFrame, fromWireEvent, fromWireKillCamClip, fromWireSnapshot, toEntityMeta, toViewerSnapshot, toWireEvent, toWireKillCamClip, toWireSnapshot } from "./wire";
import { itemFromCode, itemToCode } from "./items";
import { defaultGameConfig } from "@dotbot/game/config";

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
  moving: true,
  maxShields: 3,
  shields: 2.5,
  shieldSegments: [1, 1, 0.5],
  bays: [{ kind: "powerup", type: "health" }, { kind: "powerup", type: "radar" }, null, null],
  hold: [],
  carriedCount: 2,
  searched: false,
  pleaded: false,
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
  doors: [{
    id: "shop:entry",
    doorwayId: "entry",
    buildingId: "shop",
    floorId: "outdoor",
    position: { x: 420.123, y: 688.456 },
    width: 72,
    dir: "h",
    phase: "opening",
    openness: 0.4567,
    blocking: true,
  }],
  debug: { tickHz: 60, tickCount: 12, fps: 60, activeBodies: 1, activeDots: 1 },
};

/** An all-empty bank: the case where the encoder omits `b` and the decoder has
 * to rebuild the length from the bay count both sides share. */
const emptyBays = Array.from({ length: defaultGameConfig.baySlots }, () => null);

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
    expect(restored.doors).toEqual([expect.objectContaining({
      id: "shop:entry",
      position: { x: 420.12, y: 688.46 },
      openness: 0.46,
      phase: "opening",
      blocking: true,
    })]);
  });

  it("omits empty collections and default bot fields while preserving round-trip defaults", () => {
    const defaultBot = {
      ...bot,
      facing: 0,
      // Standing is the default, so it must not reach the wire at all.
      moving: false,
      floorId: "outdoor",
      shieldSegments: [1, 1, 1],
      shields: 3,
      bays: emptyBays,
      carriedCount: 0,
      searched: false,
      pleaded: false,
      dashCooldownMs: 0,
      dashActiveMs: 0,
      invulnerabilityMs: 0,
    } satisfies DotBotEntity;
    const full = toWireSnapshot({ ...snapshot, bots: [defaultBot], dots: [], mines: [], coverages: [], noises: [], doors: [] });
    const payload = toViewerSnapshot(full, 0);
    expect(payload).not.toHaveProperty("dotDeltas");
    expect(payload).not.toHaveProperty("dotSync");
    expect(payload).not.toHaveProperty("mines");
    expect(payload).not.toHaveProperty("coverages");
    expect(payload).not.toHaveProperty("noises");
    expect(payload).not.toHaveProperty("doors");
    expect(payload.bots[0]).toEqual({ i: defaultBot.id, p: [123.46, 987.65] });
    expect(fromWireSnapshot(payload, new Map([[defaultBot.id, toEntityMeta(defaultBot)]]), []).bots[0]).toMatchObject({
      facing: 0,
      moving: false,
      floorId: "outdoor",
      state: "alive",
      shieldSegments: [1, 1, 1],
      bays: emptyBays,
      carriedCount: 0,
      searched: false,
      pleaded: false,
    });
  });

  it("round-trips item provenance through bots, dots, and item events", () => {
    const cargo = { kind: "blueprint", blueprintId: "serverRack", sourceBuildingId: "civic" } as const;
    const full = toWireSnapshot({
      ...snapshot,
      bots: [{ ...bot, bays: [cargo, null, null], hold: [cargo], carriedCount: 2 }],
      dots: [{
        id: "runtime-drop-0",
        position: { x: 100, y: 100 },
        radius: 10,
        floorId: "outdoor",
        item: cargo,
        active: true,
        captureProgressMs: 0,
      }],
    });
    expect(full.bots[0].b?.[0]).toBe("b:serverRack");
    expect(full.bots[0].h?.[0]).toBe("b:serverRack");
    expect(full.bots[0].bs?.[0]).toBe("civic");
    expect(full.bots[0].hs?.[0]).toBe("civic");
    expect(full.dots[0].it).toBe("b:serverRack");
    expect(full.dots[0].src).toBe("civic");

    // An older decoder knows only the original scalar fields. Optional
    // provenance sidecars must never make its startsWith-based decoder crash.
    expect(() => full.bots[0].b?.filter(Boolean).map((code) => itemFromCode(code!)))
      .not.toThrow();
    expect(() => itemFromCode(full.dots[0].it)).not.toThrow();

    const restored = fromWireSnapshot(
      toViewerSnapshot(full, 0),
      new Map([[bot.id, toEntityMeta(bot)]]),
      full.dots,
    );
    expect(restored.bots[0].bays[0]).toEqual(cargo);
    expect(restored.bots[0].hold[0]).toEqual(cargo);
    expect(restored.dots[0].item).toEqual(cargo);
    expect(fromWireEvent(toWireEvent({
      type: "looted",
      botId: "body",
      byBotId: "viewer",
      items: [cargo],
    }))).toMatchObject({ items: [cargo] });
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

  it("retains the authoritative runtime set when a floor context sync arrives in the same lossy frame", () => {
    const oldRuntime: WireDot = {
      id: "runtime-drop-old",
      position: { x: 1, y: 1 },
      radius: 10,
      floorId: "outdoor",
      it: "h",
      active: true,
      rt: true,
    };
    const authored: WireDot = {
      id: "outside-authored",
      position: { x: 2, y: 2 },
      radius: 10,
      floorId: "outdoor",
      it: "r",
      active: true,
    };
    const currentRuntime: WireDot = {
      id: "runtime-drop-current",
      position: { x: 3, y: 3 },
      radius: 10,
      floorId: "outdoor",
      it: "b:desk",
      src: "mercy",
      active: true,
      rt: true,
    };
    const store = new Map([[oldRuntime.id, oldRuntime]]);

    // This frame must stand on its own if the following latest snapshot is lost.
    applyWireDotFrame(store, {
      dotSync: [{ context: "outdoor", dots: [authored] }],
      runtimeDots: [currentRuntime],
    }, (floorId) => floorId);

    expect([...store.values()]).toEqual([authored, currentRuntime]);
  });

  it("converges runtime dots after the first lossy add frame is discarded", () => {
    const store = new Map<string, WireDot>();
    const runtime = {
      id: "runtime-drop-0",
      position: { x: 10, y: 20 },
      radius: 10,
      floorId: "outdoor",
      it: "h",
      src: "mercy",
      active: true,
      rt: true,
    } satisfies WireDot;

    // The first latest-state snapshot is intentionally discarded.
    applyWireDotFrame(store, { runtimeDots: [runtime] }, (floorId) => floorId);
    expect(store.get("runtime-drop-0")).toMatchObject({
      position: { x: 10, y: 20 },
      it: "h",
      src: "mercy",
      active: true,
    });

    applyWireDotFrame(store, { runtimeDots: [] }, (floorId) => floorId);
    expect(store.has("runtime-drop-0")).toBe(false);
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

describe("event wire mapping", () => {
  it("preserves the source and target of an authoritative hit acknowledgement", () => {
    const hit = {
      type: "hit",
      botId: "target",
      byBotId: "attacker",
      result: "plateBreak",
      position: { x: 12, y: 18 },
      direction: { x: 1, y: 0 },
      tick: 42,
    } as const;
    expect(fromWireEvent(toWireEvent(hit))).toEqual(hit);
  });

  it("round-trips a dash clash without pretending it was a hit", () => {
    const clash = {
      type: "dashContact",
      botId: "right",
      byBotId: "left",
      result: "clash",
      position: { x: 120, y: 180 },
      direction: { x: 1, y: 0 },
      tick: 84,
    } as const;
    expect(fromWireEvent(toWireEvent(clash))).toEqual(clash);
  });

  it("preserves the authoritative cause of a down without inventing a remote mine owner", () => {
    const downed = {
      type: "downed",
      botId: "victim",
      byBotId: "owner",
      cause: {
        kind: "mine",
        tick: 96,
        position: { x: 300, y: 220 },
        direction: { x: 1, y: 0 },
      },
    } as const;
    expect(fromWireEvent(toWireEvent(downed))).toEqual(downed);
  });

  it("round-trips a compact private kill cam without private actor fields", () => {
    const clip = {
      id: "victim-60",
      victimId: "victim",
      sourceBotId: "killer",
      cause: { kind: "dash", tick: 60, position: { x: 10.123, y: 20.456 }, direction: { x: 1, y: 0 } },
      startTick: 0,
      deathTick: 60,
      tickHz: 60,
      frames: [{
        tick: 60,
        victim: { id: "victim", position: { x: 10.123, y: 20.456 }, facing: 1.234, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" },
        source: { id: "killer", position: { x: 30, y: 20 }, facing: 3.14, floorId: "outdoor", shieldSegments: [1, 1, 1], dashActiveMs: 10, state: "alive" },
        visibleBots: [{ id: "mate", position: { x: 18, y: 24 }, facing: 0, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" }],
        blockingDoorIds: ["door-a"],
      }],
    } satisfies KillCamClip;
    const wire = toWireKillCamClip(clip);
    expect(wire.f[0]).toHaveLength(5);
    expect(JSON.stringify(wire)).not.toContain("position");
    expect(fromWireKillCamClip(JSON.parse(JSON.stringify(wire)))).toMatchObject({
      ...clip,
      cause: { ...clip.cause, position: { x: 10.12, y: 20.46 } },
      frames: [{
        ...clip.frames[0],
        victim: {
          ...clip.frames[0].victim,
          position: { x: 10.12, y: 20.46 },
          facing: 1.23,
        },
      }],
    });
  });
});

function exhaustClient(message: ClientMessage): string {
  switch (message.type) {
    case "baseHello": return message.token;
    case "baseInput": return String(message.seq);
    case "hello": return message.token;
    case "joinSquad": return message.squadId;
    case "startMatch": return message.type;
    case "leaveRun": return message.type;
    case "killCamDone": return message.clipId;
    case "input": return String(message.seq);
    case "ping": return String(message.cts);
    default: return assertNever(message);
  }
}

function exhaustServer(message: ServerMessage): string {
  switch (message.type) {
    case "baseWelcome": return message.tutorial.phase;
    case "baseState": return message.tutorial.phase;
    case "welcome": return message.playerId;
    case "lobby": return message.hostId;
    case "matchStart": return message.yourBotId;
    case "snap": return String(message.tick);
    case "meta": return String(message.add.length);
    case "ev": return String(message.events.length);
    case "killCam": return message.clip.i;
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
    expect(exhaustClient({ type: "killCamDone", clipId: "victim-60" })).toBe("victim-60");
    expect(exhaustServer({ type: "err", code: "bad", msg: "bad" })).toBe("bad");
  });
});
