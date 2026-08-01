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
    radarPings: [{ botId: "rival", floorId: "outdoor", x: 500, y: 50, ageMs: 0 }],
    dashOverchargeMs: 1_000,
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
  it("keeps historically known squadmates and visible bystanders without leaking hidden or private state", () => {
    const history = new KillCamHistory(map, { historyTicks: 240 });
    const extras = (offset: number) => [
      bot("mate", { x: 330, y: 140 }, { state: "downed" }),
      bot("visible-party", { x: 210 + offset, y: 120 }),
      bot("hidden-party", { x: 320, y: 150 }),
      bot("invisible-party", { x: 230 + offset, y: 160 }, { incognitoMs: 500 }),
    ];
    history.record(snapshot(3, 200, { x: 320, y: 100 }, extras(0)));
    history.record(snapshot(6, 202, { x: 310, y: 100 }, extras(2)));
    history.record(snapshot(12, 204, { x: 230, y: 210 }, extras(4)));
    history.record(snapshot(15, 206, { x: 220, y: 104 }, extras(6)));

    const clip = history.createClip("victim", "killer", dashCause)!;
    expect(clip.frames.slice(0, 2).every((frame) => frame.source === undefined)).toBe(true);
    expect(clip.frames.slice(2).every((frame) => frame.source?.id === "killer")).toBe(true);
    expect(clip.frames.every((frame) => frame.visibleBots.some((actor) =>
      actor.id === "mate" && actor.state === "downed"))).toBe(true);
    expect(clip.frames.every((frame) => frame.visibleBots.some((actor) =>
      actor.id === "visible-party"))).toBe(true);

    const encoded = JSON.stringify(clip);
    expect(encoded).not.toContain("hidden-party");
    expect(encoded).not.toContain("invisible-party");
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

  it("keeps an invisible rival out of historical sight until physical contact", () => {
    const history = new KillCamHistory(map, { historyTicks: 240 });
    const hidden = snapshot(12, 100, { x: 180, y: 100 });
    hidden.bots = hidden.bots.map((entry) =>
      entry.id === "killer" ? { ...entry, incognitoMs: 500 } : entry);
    history.record(hidden);
    // Two damaged two-plate bodies overlap at 40 px even though the old
    // single-ray reach sum reported only 33.6 px. Historical disclosure has
    // to use the exact authored shape or the replay can hide a real blocker.
    const contact = snapshot(15, 100, { x: 140, y: 100 });
    contact.bots = contact.bots.map((entry) => ({
      ...entry,
      shieldSegments: [1, 1, 0],
      ...(entry.id === "killer" ? { incognitoMs: 450 } : {}),
    }));
    history.record(contact);

    const clip = history.createClip("victim", "killer", {
      ...dashCause,
      position: { x: 140, y: 100 },
    })!;
    expect(clip.frames[0].source).toBeUndefined();
    expect(clip.frames[1].source?.id).toBe("killer");
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

  it("keeps a six-second 20 Hz window and appends an off-cadence authoritative death tick", () => {
    const history = new KillCamHistory(map);
    for (let tick = 0; tick <= 357; tick += 3) {
      history.record(snapshot(tick, 100 + tick / 10, { x: 180, y: 100 }));
    }
    history.record(snapshot(358, 124, { x: 148, y: 100 }));
    const clip = history.createClip("victim", "killer", {
      ...dashCause,
      tick: 358,
      position: { x: 148, y: 100 },
    })!;

    expect(clip.startTick).toBe(0);
    expect(clip.deathTick).toBe(358);
    expect(clip.frames.at(-1)?.tick).toBe(358);
    expect(clip.frames.slice(1, -1).every((frame, index) =>
      frame.tick - clip.frames[index].tick === 3)).toBe(true);
    expect(clip.frames.at(-1)!.tick - clip.frames.at(-2)!.tick).toBe(1);
  });

  it("carries exact authoritative shield and core impacts instead of inferring sampled transitions", () => {
    const history = new KillCamHistory(map);
    history.record(snapshot(9, 200, { x: 244, y: 100 }));
    history.recordEvents([{
      type: "hit",
      botId: "victim",
      byBotId: "killer",
      result: "plateBreak",
      tick: 10,
      position: { x: 221.234, y: 92.345 },
      direction: { x: -0.75, y: 0.25 },
    }]);
    history.record(snapshot(12, 202, { x: 230, y: 105 }));
    history.recordEvents([{
      type: "hit",
      botId: "victim",
      byBotId: "killer",
      result: "downed",
      tick: 15,
      position: { x: 211.2, y: 101.5 },
      direction: { x: -1, y: 0 },
    }]);
    history.record(snapshot(15, 204, { x: 220, y: 104 }));

    const clip = history.createClip("victim", "killer", dashCause)!;
    expect(clip.impacts).toEqual([
      expect.objectContaining({ tick: 10, result: "plateBreak", sourceId: "killer" }),
      expect.objectContaining({ tick: 15, result: "downed", sourceId: "killer" }),
    ]);
    expect(clip.impacts?.[0].position).toEqual({ x: 221.234, y: 92.345 });
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

  it("records only blocking doors whose state the historical victim could observe", () => {
    const history = new KillCamHistory(map);
    const frame = snapshot(15, 100, { x: 220, y: 100 });
    frame.doors = [
      {
        id: "visible-door",
        doorwayId: "visible",
        buildingId: "test",
        floorId: "outdoor",
        position: { x: 180, y: 100 },
        width: 72,
        dir: "v",
        phase: "closed",
        openness: 0,
        blocking: true,
      },
      {
        id: "hidden-door",
        doorwayId: "hidden",
        buildingId: "test",
        floorId: "outdoor",
        position: { x: 300, y: 100 },
        width: 72,
        dir: "v",
        phase: "closed",
        openness: 0,
        blocking: true,
      },
    ];
    history.record(frame);

    const clip = history.createClip("victim", "killer", dashCause)!;
    expect(clip.frames[0].blockingDoorIds).toEqual(["visible-door"]);
  });
});
