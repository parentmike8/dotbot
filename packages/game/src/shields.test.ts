import { describe, expect, it } from "vitest";
import { applyArmourHit, coveringPlate, normalizeAngle, platesForCount, plateSum, shieldZoneAt } from "./shields";

const THIRD = (Math.PI * 2) / 3;

describe("shield geometry", () => {
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

  it("gives every angle a covering plate, seams included", () => {
    // The gaps between plates are a drawing seam, not a hole in the armour. Under
    // the core rule that stops being cosmetic: a seam that counted as bare body
    // would let a fully plated bot be dropped through fourteen degrees of nothing.
    const seam = Math.PI / 3;
    expect(shieldZoneAt(0, 3, seam)).toBeNull();
    expect([0, 1]).toContain(coveringPlate(0, 3, seam));
    for (let angle = -Math.PI; angle < Math.PI; angle += 0.02) {
      const plate = coveringPlate(0, 3, angle);
      expect(Number.isInteger(plate)).toBe(true);
      expect(plate).toBeGreaterThanOrEqual(0);
      expect(plate).toBeLessThan(3);
    }
  });
});

describe("applyArmourHit", () => {
  it("breaks the plate it lands on outright, then re-seats best-first", () => {
    const plates = platesForCount(3, 3);
    expect(applyArmourHit(0, plates, 0)).toEqual({ plate: 0, core: false });
    // The broken plate trails; the strongest survivors lead the facing again.
    expect(plates).toEqual([1, 1, 0]);
  });

  it("breaks a cracked plate rather than reaching past it", () => {
    // A cracked plate is still a plate. It is what a revive leaves you standing on.
    const plates = [1, 1, 0.5];
    expect(applyArmourHit(0, plates, -THIRD)).toEqual({ plate: 2, core: false });
    expect(plates).toEqual([1, 1, 0]);
  });

  it("reaches the core through the arc where a plate used to be", () => {
    // Two good plates and one gone. A hit through the gap ends it — the headshot.
    const plates = [1, 1, 0];
    const hit = applyArmourHit(0, plates, -THIRD);
    expect(hit).toEqual({ plate: 2, core: true });
    // Nothing left in that arc to damage, so nothing changes here.
    expect(plates).toEqual([1, 1, 0]);
    expect(plateSum(plates)).toBe(2);
  });

  it("never reaches the core while every arc still has a plate", () => {
    // A full carrier cannot be one-shot from any angle, seams included.
    for (let angle = -Math.PI; angle < Math.PI; angle += 0.01) {
      expect(applyArmourHit(0, platesForCount(3, 3), angle).core).toBe(false);
    }
  });

  it("leaves a stripped bot alive until something actually hits it", () => {
    // Losing every plate is not the down. This is the whole point of the change:
    // a naked bot can still run, still extract, still be picked up.
    const plates = [0, 0, 0];
    expect(applyArmourHit(0, plates, 0)).toEqual({ plate: 0, core: true });
    expect(plates).toEqual([0, 0, 0]);
  });

  it("keeps the best surviving plate forward no matter where hits land", () => {
    const plates = platesForCount(3, 3);

    for (const angle of [THIRD, -THIRD, Math.PI, 0, Math.PI / 3]) {
      applyArmourHit(0, plates, angle);
      const sorted = [...plates].sort((a, b) => b - a);
      expect(plates).toEqual(sorted);
    }
  });

  it("takes three hits down one arc, because the armour turns to meet you", () => {
    // Re-seating is what makes the fast kill a skill: hit the same spot twice and
    // the second lands on a fresh plate that rotated in to cover it. To reach the
    // core you have to catch the arc the broken plate has drifted to.
    const plates = platesForCount(3, 3);
    expect(applyArmourHit(0, plates, 0).core).toBe(false);
    expect(applyArmourHit(0, plates, 0).core).toBe(false);
    expect(applyArmourHit(0, plates, 0).core).toBe(false);
    expect(plates).toEqual([0, 0, 0]);
    expect(applyArmourHit(0, plates, 0).core).toBe(true);

    // Or two, if you get behind them while their broken arc is still trailing.
    const flanked = platesForCount(3, 3);
    expect(applyArmourHit(0, flanked, 0).core).toBe(false);
    expect(flanked).toEqual([1, 1, 0]);
    expect(applyArmourHit(0, flanked, -THIRD).core).toBe(true);
  });
});
