import { describe, expect, it } from "vitest";
import { coincidentSeparationAxis, separationAxis, separationPush } from "./kinematics";
import type { Vec2 } from "./types";

const MAX_PUSH = 5;
/** What the pair's two silhouettes touch at: two plain 24-radius bodies. */
const GAP = 48;

describe("separation at coincident centres", () => {
  /**
   * The degenerate case the old fallback got wrong, stated as the invariant it
   * violated. `separationPush` is called once per body with the arguments
   * swapped; at distance zero there is no centre line, and the invented one has
   * to disagree between the two calls or the pair translates in lockstep.
   */
  it("gives the two halves of a pair exactly opposite headings", () => {
    for (const [left, right] of [["bot-a", "bot-b"], ["zz", "aa"], ["squad-1:3", "squad-1:11"]]) {
      const forward = coincidentSeparationAxis(left, right);
      const backward = coincidentSeparationAxis(right, left);
      expect(forward.x).toBeCloseTo(-backward.x, 12);
      expect(forward.y).toBeCloseTo(-backward.y, 12);
      expect(Math.hypot(forward.x, forward.y)).toBeCloseTo(1, 12);
    }
  });

  it("pushes two stacked bodies apart instead of translating them together", () => {
    const shared: Vec2 = { x: 300, y: 300 };
    const axisA = coincidentSeparationAxis("alpha", "beta");
    const axisB = coincidentSeparationAxis("beta", "alpha");
    const pushA = separationPush(shared, shared, GAP, MAX_PUSH, 0.5, axisA);
    const pushB = separationPush(shared, shared, GAP, MAX_PUSH, 0.5, axisB);

    // Both bodies move at the cap, and the pair's centre of mass does not.
    expect(Math.hypot(pushA.x, pushA.y)).toBeCloseTo(MAX_PUSH, 12);
    expect(Math.hypot(pushB.x, pushB.y)).toBeCloseTo(MAX_PUSH, 12);
    expect(pushA.x + pushB.x).toBeCloseTo(0, 12);
    expect(pushA.y + pushB.y).toBeCloseTo(0, 12);
    // And they genuinely separate: a shared heading would leave this at zero.
    expect(Math.hypot(pushA.x - pushB.x, pushA.y - pushB.y)).toBeCloseTo(2 * MAX_PUSH, 12);
  });

  it("is a pure function of the id pair, so server and client agree", () => {
    expect(coincidentSeparationAxis("bot-a", "bot-b")).toEqual(coincidentSeparationAxis("bot-a", "bot-b"));
    // Different pairs get spread over headings rather than all extruding one
    // stack into a single line.
    const headings = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => {
        const axis = coincidentSeparationAxis("hub", id);
        return `${axis.x.toFixed(6)},${axis.y.toFixed(6)}`;
      }),
    );
    expect(headings.size).toBeGreaterThan(2);
  });

  it("only reaches for the fallback when the centres actually coincide", () => {
    const fallback: Vec2 = { x: 0, y: 1 };
    expect(separationAxis({ x: 10, y: 0 }, { x: 0, y: 0 }, fallback)).toEqual({ x: 1, y: 0 });
    expect(separationAxis({ x: 5, y: 5 }, { x: 5, y: 5 }, fallback)).toEqual(fallback);
  });
});

describe("separationPush", () => {
  it("yields nothing when the bodies are clear or the body is an anchor", () => {
    const axis = coincidentSeparationAxis("a", "b");
    expect(separationPush({ x: 0, y: 0 }, { x: 100, y: 0 }, GAP, MAX_PUSH, 0.5, axis)).toEqual({ x: 0, y: 0 });
    expect(separationPush({ x: 0, y: 0 }, { x: 10, y: 0 }, GAP, MAX_PUSH, 0, axis)).toEqual({ x: 0, y: 0 });
  });

  it("splits the overlap by the yield fraction and caps the result", () => {
    const axis = coincidentSeparationAxis("a", "b");
    // 8 px of overlap, half of it, well under the cap.
    expect(separationPush({ x: 40, y: 0 }, { x: 0, y: 0 }, GAP, MAX_PUSH, 0.5, axis).x).toBeCloseTo(4, 12);
    // 38 px of overlap, all of it, clipped to the per-tick cap.
    expect(separationPush({ x: 10, y: 0 }, { x: 0, y: 0 }, GAP, MAX_PUSH, 1, axis).x).toBeCloseTo(MAX_PUSH, 12);
  });
});
