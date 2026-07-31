import { describe, expect, it } from "vitest";
import { getKeyboardVector, mergeMoveVectors } from "./input";

describe("movement input", () => {
  it("keeps keyboard movement at full speed", () => {
    expect(getKeyboardVector(new Set(["KeyD"]))).toEqual({ x: 1, y: 0 });

    const diagonal = getKeyboardVector(new Set(["KeyW", "KeyD"]));
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 8);
  });

  it("preserves a partial joystick when no keyboard direction is held", () => {
    expect(mergeMoveVectors({ x: 0, y: 0 }, { x: 0.25, y: -0.5 }))
      .toEqual({ x: 0.25, y: -0.5 });
  });

  it("caps combined keyboard and joystick input without exceeding full speed", () => {
    const combined = mergeMoveVectors({ x: 1, y: 0 }, { x: 0.5, y: -0.5 });
    expect(Math.hypot(combined.x, combined.y)).toBeCloseTo(1, 8);
  });

  it("keeps held keyboard movement full speed against partial opposing touch input", () => {
    expect(mergeMoveVectors({ x: 1, y: 0 }, { x: -0.25, y: 0 })).toEqual({ x: 1, y: 0 });

    const nearlyCancelled = mergeMoveVectors({ x: 1, y: 0 }, { x: -0.96, y: 0 });
    expect(Math.hypot(nearlyCancelled.x, nearlyCancelled.y)).toBeCloseTo(1, 8);
  });
});
