import { describe, expect, it } from "vitest";
import {
  advanceInterpolationDelayMs,
  maximumInterpolationDelayMs,
  minimumInterpolationDelayMs,
  targetInterpolationDelayMs,
} from "./adaptiveBuffer";

describe("adaptive interpolation buffer", () => {
  it("starts conservative, then releases to the stable floor", () => {
    expect(targetInterpolationDelayMs(Array(10).fill(50))).toBe(maximumInterpolationDelayMs);
    expect(targetInterpolationDelayMs(Array(40).fill(50))).toBe(minimumInterpolationDelayMs);
  });

  it("adds measured tail slack without exceeding the safe ceiling", () => {
    const mildlyBursty = [...Array(32).fill(50), ...Array(8).fill(88)];
    expect(targetInterpolationDelayMs(mildlyBursty)).toBe(113);
    expect(targetInterpolationDelayMs([...Array(30).fill(50), ...Array(10).fill(200)]))
      .toBe(maximumInterpolationDelayMs);
  });

  it("grows faster than it shrinks", () => {
    expect(advanceInterpolationDelayMs(75, 125, 100)).toBe(93);
    expect(advanceInterpolationDelayMs(125, 75, 100)).toBeCloseTo(123.8);
  });
});
