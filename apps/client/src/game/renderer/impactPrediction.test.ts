import type { DotBotEntity, GameSnapshot } from "@dotbot/game/types";
import { describe, expect, it } from "vitest";
import { applyPredictedImpactOverlays, predictedImpactHoldMs, type QueuedPredictedImpact } from "./impactPrediction";

function target(shieldSegments = [1, 1, 1]): DotBotEntity {
  return {
    id: "target", name: "Target", squadId: "bravo", isAmbient: false, color: "#fff", state: "alive",
    position: { x: 100, y: 100 }, radius: 24, floorId: "outdoor", facing: 0,
    maxShields: 3, shields: shieldSegments.reduce((sum, value) => sum + value, 0), shieldSegments,
    bays: [null, null, null, null], hold: [], carriedCount: 0, radarActiveMs: 0, radarPings: [],
    dashOverchargeCharges: 0, incognitoMs: 0, dashCooldownMs: 0, dashActiveMs: 0, invulnerabilityMs: 0,
  };
}

function snapshot(bot = target()): GameSnapshot {
  return {
    timeMs: 0, bots: [bot], dots: [], mines: [], coverages: [], noises: [],
    debug: { tickHz: 60, tickCount: 0, fps: 60, activeBodies: 1, activeDots: 0 },
  };
}

describe("predicted impact presentation", () => {
  it("breaks the visible shield plate immediately without mutating authoritative state", () => {
    const authoritative = snapshot();
    const impacts: QueuedPredictedImpact[] = [{ x: 124, y: 100, targetId: "target", startedAt: 1_000 }];

    const presented = applyPredictedImpactOverlays(authoritative, impacts, 1_000);

    expect(presented.bots[0].shieldSegments).toEqual([1, 1, 0]);
    expect(presented.bots[0].shields).toBe(2);
    expect(authoritative.bots[0].shieldSegments).toEqual([1, 1, 1]);
  });

  it("hands presentation to the first authoritative change instead of double-applying", () => {
    const impacts: QueuedPredictedImpact[] = [{ x: 124, y: 100, targetId: "target", startedAt: 1_000 }];
    applyPredictedImpactOverlays(snapshot(), impacts, 1_000);

    const confirmed = applyPredictedImpactOverlays(snapshot(target([1, 1, 0])), impacts, 1_050);
    expect(confirmed.bots[0].shieldSegments).toEqual([1, 1, 0]);
  });

  it("rolls back an unconfirmed visual prediction after the bounded hold", () => {
    const impacts: QueuedPredictedImpact[] = [{ x: 124, y: 100, targetId: "target", startedAt: 1_000 }];
    applyPredictedImpactOverlays(snapshot(), impacts, 1_000);

    const expired = applyPredictedImpactOverlays(snapshot(), impacts, 1_000 + predictedImpactHoldMs + 1);
    expect(expired.bots[0].shieldSegments).toEqual([1, 1, 1]);
  });
});
