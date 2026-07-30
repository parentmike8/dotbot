import { describe, expect, it } from "vitest";
import type { DotBotEntity, DownCause, GameSnapshot, MapDocument } from "@dotbot/game/types";
import { KillCamHistory } from "./killCam";

const map: MapDocument = {
  id: "kill-cam-test",
  name: "Kill Cam Test",
  width: 600,
  height: 400,
  outdoor: {
    roads: [],
    parks: [],
    walls: [{ id: "screen", x: 250, y: 20, w: 12, h: 170 }],
    objects: [],
    dotSpawns: [],
  },
  buildings: [],
  extractionPoints: [],
  insertionPoints: [],
  botSpawns: [],
};

function bot(id: string, position: { x: number; y: number }, overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return {
    id,
    name: id,
    squadId: id === "victim" || id === "mate" ? "alpha" : "bravo",
    isAmbient: false,
    color: "#111",
    position: { ...position },
    radius: 24,
    state: "alive",
    floorId: "outdoor",
    facing: 0,
    moving: false,
    maxShields: 3,
    shields: 3,
    shieldSegments: [1, 1, 1],
    bays: [{ kind: "powerup", type: "health" }, null, null, null],
    hold: [{ kind: "powerup", type: "radar" }],
    carriedCount: 2,
    searched: false,
    pleaded: false,
    radarActiveMs: 500,
    radarPings: [{ x: 500, y: 50, ageMs: 0 }],
    dashOverchargeCharges: 1,
    incognitoMs: 0,
    dashCooldownMs: 0,
    dashActiveMs: 0,
    invulnerabilityMs: 0,
    ...overrides,
  };
}

function snapshot(tick: number, victimX: number, killer: { x: number; y: number }, extra: DotBotEntity[] = []): GameSnapshot {
  const bots = [
    bot("victim", { x: victimX, y: 100 }),
    bot("killer", killer, { dashActiveMs: tick >= 12 ? 100 : 0 }),
    ...extra,
  ];
  return {
    timeMs: tick * (1000 / 60),
    bots,
    dots: [],
    mines: [],
    coverages: [],
    noises: [],
    doors: [],
    debug: { tickHz: 60, tickCount: tick, fps: 60, activeBodies: bots.length, activeDots: 0 },
  };
}

const dashCause: DownCause = {
  kind: "dash",
  tick: 15,
  position: { x: 220, y: 104 },
  direction: { x: -1, y: 0 },
};

describe("KillCamHistory", () => {
  it("omits a hidden approach and every unrelated/private field, then admits the killer once visible", () => {
    const history = new KillCamHistory(map, { historyTicks: 240 });
    history.record(snapshot(3, 200, { x: 320, y: 100 }, [bot("third-party", { x: 210, y: 120 })]));
    history.record(snapshot(6, 202, { x: 310, y: 100 }, [bot("third-party", { x: 212, y: 120 })]));
    history.record(snapshot(12, 204, { x: 230, y: 210 }, [bot("third-party", { x: 214, y: 120 })]));
    history.record(snapshot(15, 206, { x: 220, y: 104 }, [bot("third-party", { x: 216, y: 120 })]));

    const clip = history.createClip("victim", "killer", dashCause)!;
    expect(clip.frames.slice(0, 2).every((frame) => frame.source === undefined)).toBe(true);
    expect(clip.frames.slice(2).every((frame) => frame.source?.id === "killer")).toBe(true);

    const encoded = JSON.stringify(clip);
    expect(encoded).not.toContain("third-party");
    expect(encoded).not.toContain("health");
    expect(encoded).not.toContain("radar");
    expect(encoded).not.toContain("radarPings");
  });

  it("never includes a cross-floor source and represents a mine by device/impact without its owner", () => {
    const history = new KillCamHistory(map, { historyTicks: 240 });
    history.record(snapshot(3, 200, { x: 220, y: 100 }, [
      bot("cross-floor", { x: 205, y: 100 }, { floorId: "tower:F1" }),
    ]));
    const crossFloor = history.createClip("victim", "cross-floor", dashCause)!;
    expect(crossFloor.frames.every((frame) => frame.source === undefined)).toBe(true);

    const mineCause: DownCause = {
      kind: "mine",
      tick: 3,
      position: { x: 203, y: 100 },
      direction: { x: -1, y: 0 },
    };
    const mine = history.createClip("victim", "killer", mineCause)!;
    expect(mine.sourceBotId).toBeUndefined();
    expect(mine.cause.kind).toBe("mine");
    expect(JSON.stringify(mine)).not.toContain("killer");
  });

  it("prunes by tick and copies recorded state instead of retaining mutable snapshots", () => {
    const history = new KillCamHistory(map, { historyTicks: 9 });
    const first = snapshot(3, 100, { x: 120, y: 100 });
    history.record(first);
    first.bots[0].position.x = 999;
    history.record(snapshot(6, 110, { x: 125, y: 100 }));
    history.record(snapshot(12, 120, { x: 130, y: 100 }));
    history.record(snapshot(15, 130, { x: 135, y: 100 }));

    expect(history.frameCount).toBe(3);
    const clip = history.createClip("victim", "killer", { ...dashCause, tick: 15 })!;
    expect(clip.frames[0].tick).toBe(6);
    expect(clip.frames.some((frame) => frame.victim.position.x === 999)).toBe(false);
  });

  it("keeps a four-second 20 Hz window and appends an off-cadence authoritative death tick", () => {
    const history = new KillCamHistory(map);
    for (let tick = 0; tick <= 237; tick += 3) {
      history.record(snapshot(tick, 100 + tick / 10, { x: 180, y: 100 }));
    }
    history.record(snapshot(238, 124, { x: 148, y: 100 }));
    const clip = history.createClip("victim", "killer", {
      ...dashCause,
      tick: 238,
      position: { x: 148, y: 100 },
    })!;

    expect(clip.startTick).toBe(0);
    expect(clip.deathTick).toBe(238);
    expect(clip.frames.at(-1)?.tick).toBe(238);
    expect(clip.frames.slice(1, -1).every((frame, index) =>
      frame.tick - clip.frames[index].tick === 3)).toBe(true);
    expect(clip.frames.at(-1)!.tick - clip.frames.at(-2)!.tick).toBe(1);
  });

  it("keeps an unknown environmental cause source-free", () => {
    const history = new KillCamHistory(map);
    history.record(snapshot(15, 206, { x: 220, y: 104 }));
    const clip = history.createClip("victim", "killer", {
      kind: "environment",
      tick: 15,
      position: { x: 206, y: 104 },
      direction: { x: 0, y: 0 },
    })!;
    expect(clip.sourceBotId).toBeUndefined();
    expect(clip.frames.every((frame) => frame.source === undefined)).toBe(true);
  });
});
