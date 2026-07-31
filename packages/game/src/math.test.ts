import { describe, expect, it } from "vitest";
import { clampInputVector, length } from "./math";

describe("clampInputVector", () => {
  it("preserves partial analog magnitude", () => {
    expect(clampInputVector({ x: 0.25, y: -0.5 })).toEqual({ x: 0.25, y: -0.5 });
  });

  it("caps keyboard diagonals and out-of-range input to the unit circle", () => {
    const diagonal = clampInputVector({ x: 1, y: -1 });
    const outOfRange = clampInputVector({ x: 4, y: 0 });

    expect(length(diagonal)).toBeCloseTo(1, 8);
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2, 8);
    expect(diagonal.y).toBeCloseTo(-Math.SQRT1_2, 8);
    expect(outOfRange).toEqual({ x: 1, y: 0 });
  });
});
