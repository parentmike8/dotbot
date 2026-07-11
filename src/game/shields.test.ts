import { describe, expect, it } from "vitest";
import { applyShieldHit, normalizeAngle, platesForCount, plateSum, shieldZoneAt } from "./shields";

const THIRD = (Math.PI * 2) / 3;

describe("shield plates", () => {
  it("normalizes angles into [-PI, PI)", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(-Math.PI);
    expect(normalizeAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI / 2);
  });

  it("resolves impact zones relative to facing", () => {
    // Facing east with three plates: plate 0 dead ahead, 1 and 2 on the flanks.
    expect(shieldZoneAt(0, 3, 0)).toBe(0);
    expect(shieldZoneAt(0, 3, THIRD)).toBe(1);
    expect(shieldZoneAt(0, 3, -THIRD)).toBe(2);
    // Dead-center between plates is bare body.
    expect(shieldZoneAt(0, 3, Math.PI / 3)).toBeNull();
    // Facing rotates the whole array with the bot.
    expect(shieldZoneAt(Math.PI / 2, 3, Math.PI / 2)).toBe(0);
    expect(shieldZoneAt(Math.PI / 2, 3, Math.PI / 2 + THIRD)).toBe(1);
  });

  it("shatters a live plate outright on a direct hit, then re-seats best-first", () => {
    const plates = platesForCount(3, 3);
    expect(applyShieldHit(0, plates, 0)).toEqual({ plate: 0, direct: true });
    // The broken plate trails; the strongest survivors lead the facing again.
    expect(plates).toEqual([1, 1, 0]);
  });

  it("cracks the nearest surviving plate on a body hit — two to break", () => {
    const plates = platesForCount(3, 3);
    const gapAngle = Math.PI / 3;

    expect(applyShieldHit(0, plates, gapAngle).direct).toBe(false);
    expect(plateSum(plates)).toBe(2.5);
    expect(plates).toEqual([1, 1, 0.5]);

    expect(applyShieldHit(0, plates, gapAngle).direct).toBe(false);
    expect(plateSum(plates)).toBe(2);
    expect(plates).toEqual([1, 0.5, 0.5]);
  });

  it("treats hits through a broken plate's zone as body hits", () => {
    const plates = [1, 0, 0];
    const hit = applyShieldHit(0, plates, THIRD);

    expect(hit.direct).toBe(false);
    expect(plateSum(plates)).toBe(0.5);
    expect(plates).toEqual([0.5, 0, 0]);
  });

  it("keeps the best surviving plate forward no matter where hits land", () => {
    const plates = platesForCount(3, 3);

    for (const angle of [THIRD, -THIRD, Math.PI, 0, Math.PI / 3]) {
      applyShieldHit(0, plates, angle);
      const sorted = [...plates].sort((a, b) => b - a);
      expect(plates).toEqual(sorted);
    }
  });

  it("reports null when no plates survive", () => {
    const plates = [0, 0, 0];
    expect(applyShieldHit(0, plates, 0)).toEqual({ plate: null, direct: false });
    expect(plates).toEqual([0, 0, 0]);
  });
});
