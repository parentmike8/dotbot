import { describe, expect, it } from "vitest";
import { EARSHOT_EDGE_GAIN, EARSHOT_FULL, EARSHOT_RADIUS, earshotGain } from "./earshot";
import type { Rect, Vec2 } from "@dotbot/game/types";

/** A phone-ish view, and the listener in the middle of it. */
const listener: Vec2 = { x: 1000, y: 1000 };
const view: Rect = { x: 1000 - 420, y: 1000 - 700, w: 840, h: 1400 };

describe("earshot", () => {
  it("plays a hit on top of you at full volume", () => {
    expect(earshotGain({ x: 1000, y: 1000 }, listener, view)).toBe(1);
    expect(earshotGain({ x: 1000 + EARSHOT_FULL, y: 1000 }, listener, view)).toBe(1);
  });

  it("silences a hit across the map", () => {
    expect(earshotGain({ x: 3800, y: 2600 }, listener, view)).toBe(0);
  });

  /**
   * The invariant the whole design rests on. Sample the view's own edges and corners:
   * every one of them is drawn, so every one of them must make a sound.
   */
  it("never silences a hit that is drawn on screen", () => {
    const xs = [view.x, view.x + view.w / 2, view.x + view.w];
    const ys = [view.y, view.y + view.h / 2, view.y + view.h];
    for (const x of xs) {
      for (const y of ys) {
        expect(earshotGain({ x, y }, listener, view), `${x},${y}`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The half the view rect alone would have got wrong. A hit a hair past the bezel is
   * still next to you, and a hard edge at the screen boundary teaches the player that
   * sound stops where the window does.
   */
  it("still hears a hit just off screen", () => {
    const justPast = { x: view.x - 20, y: listener.y };
    expect(earshotGain(justPast, listener, view)).toBeGreaterThan(0);
  });

  /** West of the view, level with the listener, so distance is purely the x offset. */
  it("silences a hit off screen past the radius", () => {
    expect(earshotGain({ x: listener.x - EARSHOT_RADIUS - 1, y: listener.y }, listener, view)).toBe(0);
    expect(earshotGain({ x: listener.x - EARSHOT_RADIUS + 1, y: listener.y }, listener, view)).toBeGreaterThan(0);
  });

  it("gets quieter with distance, and never below the edge gain while audible", () => {
    const gains = [300, 450, 600, 700].map((d) => earshotGain({ x: 1000, y: 1000 + d }, listener, view));
    for (let i = 1; i < gains.length; i += 1) {
      expect(gains[i]).toBeLessThan(gains[i - 1]);
    }
    for (const gain of gains) {
      expect(gain).toBeGreaterThanOrEqual(EARSHOT_EDGE_GAIN);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The reason the viewport half-extent cannot be a constant: a wide desktop view is
   * several times an EARSHOT_RADIUS across, so a fixed number would have gone silent
   * in the middle of the screen.
   */
  it("reaches further on a wider view", () => {
    const wide: Rect = { x: 1000 - 1600, y: 1000 - 900, w: 3200, h: 1800 };
    const far = { x: 1000 + 1500, y: 1000 };
    expect(earshotGain(far, listener, view)).toBe(0);
    expect(earshotGain(far, listener, wide)).toBeGreaterThan(0);
  });

  /**
   * The camera clamps to the sheet, so in a corner of the map the player sits well off
   * the centre of their own view. Measuring reach from the view's centre would have
   * silenced the far half of the screen; measuring it from the listener to the FARTHEST
   * corner is what keeps the guarantee.
   */
  it("holds the guarantee when the player is pinned to a corner of the view", () => {
    const cornered: Vec2 = { x: 120, y: 120 };
    const clamped: Rect = { x: 0, y: 0, w: 1600, h: 1000 };
    expect(earshotGain({ x: 1600, y: 1000 }, cornered, clamped)).toBeGreaterThan(0);
  });

  it("falls back to the radius before anything has been drawn", () => {
    expect(earshotGain({ x: 1000, y: 1000 + EARSHOT_RADIUS - 1 }, listener, null)).toBeGreaterThan(0);
    expect(earshotGain({ x: 1000, y: 1000 + EARSHOT_RADIUS + 1 }, listener, null)).toBe(0);
  });
});
