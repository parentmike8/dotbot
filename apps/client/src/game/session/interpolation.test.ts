import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import { describe, expect, it } from "vitest";
import { capRemoteRecovery, fastForwardCombatState, sampleTimeline } from "./interpolation";

function bot(id: string, x: number): DotBotEntity {
  return {
    id, name: id, squadId: "alpha", isAmbient: false, color: "#fff", state: "alive",
    position: { x, y: 100 }, radius: 24, floorId: "outdoor", facing: 0,
    maxShields: 3, shields: 3, shieldSegments: [1, 1, 1], bays: [null, null, null, null],
    hold: [], carriedCount: 0, radarActiveMs: 0, radarPings: [], dashOverchargeCharges: 0,
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
});
