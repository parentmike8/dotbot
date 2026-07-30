import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import { describe, expect, it } from "vitest";
import { capRemoteRecovery, fastForwardCombatState, sampleTimeline } from "./interpolation";

function bot(id: string, x: number): DotBotEntity {
  return {
    id, name: id, squadId: "alpha", isAmbient: false, color: "#fff", state: "alive",
    position: { x, y: 100 }, radius: 24, floorId: "outdoor", facing: 0, moving: false,
    maxShields: 3, shields: 3, shieldSegments: [1, 1, 1], bays: [null, null, null, null],
    hold: [], carriedCount: 0, searched: false, pleaded: false, radarActiveMs: 0, radarPings: [], dashOverchargeCharges: 0,
    incognitoMs: 0, dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
  };
}

function snapshot(tick: number, x: number): GameSnapshot {
  return {
    timeMs: tick * (1000 / 60), bots: [bot("remote", x)], dots: [], mines: [], coverages: [], noises: [],
    debug: { tickHz: 60, tickCount: tick, fps: 60, activeBodies: 1, activeDots: 0 },
  };
}

describe("fixed-delay interpolation", () => {
  const samples = [
    { tick: 0, snapshot: snapshot(0, 0) },
    { tick: 3, snapshot: snapshot(3, 30) },
    { tick: 6, snapshot: snapshot(6, 60) },
    { tick: 9, snapshot: snapshot(9, 90) },
  ];

  it("uses server ticks so bursty delivery still produces monotonic positions", () => {
    const positions = [1, 2.5, 4, 5.5, 7, 8.5].map((tick) =>
      sampleTimeline(samples, tick, 3)!.snapshot.bots[0].position.x,
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).toEqual([10, 25, 40, 55, 70, 85]);
  });

  it("caps under-run extrapolation at one snapshot interval, then holds", () => {
    const near = sampleTimeline(samples, 11, 3)!;
    const stalled = sampleTimeline(samples, 40, 3)!;
    expect(near.snapshot.bots[0].position.x).toBe(110);
    expect(stalled.snapshot.bots[0].position.x).toBe(120);
    expect(stalled.underRunTicks).toBe(31);
  });

  it("caps recovery correction distance instead of teleporting", () => {
    const previous = snapshot(12, 120);
    const target = snapshot(13, 40);
    const recovered = capRemoteRecovery(previous, target, "own", 16, 1000);
    expect(recovered.bots[0].position.x).toBe(104);
  });

  it("fast-forwards remote combat state onto delayed positions, never the own bot", () => {
    const sampled = snapshot(6, 60);
    sampled.bots.push({ ...bot("own", 500) });
    const freshest = snapshot(9, 90);
    freshest.bots[0] = { ...freshest.bots[0], state: "downed", shields: 0, shieldSegments: [0, 0, 0], invulnerabilityMs: 500 };
    freshest.bots.push({ ...bot("own", 520), shields: 1, shieldSegments: [1, 0, 0] });

    const merged = fastForwardCombatState(sampled, freshest, "own");
    const remote = merged.bots.find(({ id }) => id === "remote")!;
    // Plate state and downed/consumed arrive at freshest truth immediately…
    expect(remote.state).toBe("downed");
    expect(remote.shieldSegments).toEqual([0, 0, 0]);
    expect(remote.invulnerabilityMs).toBe(500);
    // …while the position stays on the smooth delayed timeline.
    expect(remote.position.x).toBe(60);
    // The own bot is prediction's job — untouched here.
    const own = merged.bots.find(({ id }) => id === "own")!;
    expect(own.shieldSegments).toEqual([1, 1, 1]);
  });

  it("reuses immutable source indexes without changing repeated render samples", () => {
    const before = structuredClone(samples);
    const first = sampleTimeline(samples, 4.25, 3);
    const second = sampleTimeline(samples, 4.25, 3);

    expect(second).toEqual(first);
    expect(samples).toEqual(before);
    expect(second?.snapshot).not.toBe(first?.snapshot);
    expect(second?.snapshot.bots).not.toBe(first?.snapshot.bots);
  });

  it("keeps radar-ping interpolation identical on the non-empty path", () => {
    const older = snapshot(0, 0);
    const newer = snapshot(3, 30);
    older.bots[0].radarPings = [{ x: 25, y: 40, ageMs: 10 }];
    newer.bots[0].radarPings = [{ x: 25, y: 40, ageMs: 40 }];

    const sampled = sampleTimeline([
      { tick: 0, snapshot: older },
      { tick: 3, snapshot: newer },
    ], 1.5, 3)!;

    expect(sampled.snapshot.bots[0].radarPings).toEqual([{ x: 25, y: 40, ageMs: 25 }]);
    expect(sampled.snapshot.bots[0].radarPings).not.toBe(older.bots[0].radarPings);
  });

  it("observes entity replacement, addition, and freshest-state mutation after a cache warmup", () => {
    const older = snapshot(0, 0);
    const newer = snapshot(3, 30);
    const mutableSamples = [
      { tick: 0, snapshot: older },
      { tick: 3, snapshot: newer },
    ];

    const warmed = sampleTimeline(mutableSamples, 1.5, 3)!;
    fastForwardCombatState(warmed.snapshot, newer, "own");

    newer.bots[0] = {
      ...newer.bots[0],
      position: { x: 90, y: 100 },
      state: "downed",
      shields: 0,
      shieldSegments: [0, 0, 0],
    };
    older.bots.push(bot("added", 0));
    newer.bots.push(bot("added", 120));

    const candidate = sampleTimeline(mutableSamples, 1.5, 3)!;
    const freshest = fastForwardCombatState(candidate.snapshot, newer, "own");

    expect(candidate.snapshot.bots.find(({ id }) => id === "remote")?.position.x).toBe(45);
    expect(candidate.snapshot.bots.find(({ id }) => id === "added")?.position.x).toBe(60);
    expect(freshest.bots.find(({ id }) => id === "remote")).toMatchObject({
      state: "downed",
      shields: 0,
      shieldSegments: [0, 0, 0],
    });
  });

  it("invalidates every indexed collection while preserving live nested mutations", () => {
    const older = snapshot(0, 0);
    const newer = snapshot(3, 30);
    older.bots[0].radarPings = [{ x: 25, y: 40, ageMs: 0 }];
    newer.bots[0].radarPings = [{ x: 25, y: 40, ageMs: 30 }];
    older.dots = [{
      id: "dot",
      position: { x: 20, y: 30 },
      radius: 10,
      item: { kind: "powerup", type: "health" },
      floorId: "outdoor",
      active: true,
      captureProgressMs: 0,
    }];
    newer.dots = [{ ...older.dots[0], position: { ...older.dots[0].position }, captureProgressMs: 30 }];
    older.mines = [{
      id: "mine",
      position: { x: 0, y: 50 },
      radius: 10,
      placedByBotId: "remote",
      squadId: "alpha",
      floorId: "outdoor",
      placedAtMs: 0,
      revealedToBotIds: [],
    }];
    newer.mines = [{ ...older.mines[0], position: { x: 30, y: 50 }, revealedToBotIds: [] }];
    older.coverages = [{ kind: "capture", actorId: "remote", targetId: "dot", progressMs: 0, durationMs: 100 }];
    newer.coverages = [{ ...older.coverages[0], progressMs: 30 }];
    older.noises = [{
      id: "noise",
      kind: "dash",
      position: { x: 0, y: 70 },
      floorId: "outdoor",
      loudness: 0.3,
      ageMs: 0,
      ttlMs: 900,
    }];
    newer.noises = [{ ...older.noises[0], position: { x: 30, y: 70 }, ageMs: 30 }];
    older.doors = [{
      id: "door",
      doorwayId: "doorway",
      buildingId: "building",
      floorId: "outdoor",
      position: { x: 80, y: 90 },
      width: 60,
      dir: "v",
      phase: "opening",
      openness: 0,
      blocking: true,
    }];
    newer.doors = [{ ...older.doors[0], position: { ...older.doors[0].position }, openness: 0.3 }];
    const mutableSamples = [
      { tick: 0, snapshot: older },
      { tick: 3, snapshot: newer },
    ];

    sampleTimeline(mutableSamples, 1.5, 3);
    newer.bots[0].radarPings[0].ageMs = 90;
    newer.dots[0] = { ...newer.dots[0], captureProgressMs: 90 };
    older.dots.push({ ...older.dots[0], id: "added-dot", captureProgressMs: 0 });
    newer.dots.push({ ...newer.dots[0], id: "added-dot", captureProgressMs: 120 });
    newer.mines.splice(0, 1);
    newer.coverages[0] = { ...newer.coverages[0], progressMs: 90 };
    newer.noises[0].ageMs = 90;
    newer.doors[0] = { ...newer.doors[0], openness: 0.9 };

    const candidate = sampleTimeline(mutableSamples, 1.5, 3)!.snapshot;

    expect(candidate.bots[0].radarPings[0].ageMs).toBe(45);
    expect(candidate.dots.find(({ id }) => id === "dot")?.captureProgressMs).toBe(45);
    expect(candidate.dots.find(({ id }) => id === "added-dot")?.captureProgressMs).toBe(60);
    expect(candidate.mines[0].position.x).toBe(0);
    expect(candidate.coverages[0].progressMs).toBe(45);
    expect(candidate.noises[0]).toMatchObject({ position: { x: 15, y: 70 }, ageMs: 45 });
    expect(candidate.doors?.[0].openness).toBeCloseTo(0.45);
  });

  it("invalidates an index when an entity key mutates in place", () => {
    const older = snapshot(0, 0);
    const newer = snapshot(3, 30);
    older.noises = [{
      id: "noise",
      kind: "dash",
      position: { x: 0, y: 70 },
      floorId: "outdoor",
      loudness: 0.3,
      ageMs: 0,
      ttlMs: 900,
    }];
    newer.noises = [{ ...older.noises[0], position: { x: 30, y: 70 }, ageMs: 30 }];
    const mutableSamples = [
      { tick: 0, snapshot: older },
      { tick: 3, snapshot: newer },
    ];

    sampleTimeline(mutableSamples, 1.5, 3);
    newer.noises[0].id = "renamed";

    expect(sampleTimeline(mutableSamples, 1.5, 3)?.snapshot.noises[0]).toMatchObject({
      id: "noise",
      position: { x: 0, y: 70 },
      ageMs: 0,
    });
  });
});
