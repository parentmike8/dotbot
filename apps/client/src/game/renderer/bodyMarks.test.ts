import { describe, expect, it } from "vitest";
import { NORTH, brokenRingArcs, carryTickAngles, waterlineArc } from "./bodyMarks";

describe("waterlineArc", () => {
  it("draws nothing at empty and the whole disc at full", () => {
    expect(waterlineArc(0)).toBeNull();
    expect(waterlineArc(-1)).toBeNull();
    expect(waterlineArc(1)).toEqual([0, Math.PI * 2]);
    expect(waterlineArc(2)).toEqual([0, Math.PI * 2]);
  });

  it("fills from the bottom, so half is the lower half", () => {
    // Screen y grows downward: the filled segment has to be the arc through +y,
    // or the gauge drains upward and reads as the opposite of what it means.
    const [from, to] = waterlineArc(0.5)!;
    expect(from).toBeCloseTo(0, 10);
    expect(to).toBeCloseTo(Math.PI, 10);
    const midpoint = (from + to) / 2;
    expect(Math.sin(midpoint)).toBeGreaterThan(0);
  });

  it("rises monotonically, and every level keeps its segment below the line", () => {
    let previous = -Infinity;
    for (let level = 0.05; level < 1; level += 0.05) {
      const [from, to] = waterlineArc(level)!;
      const swept = to - from;
      expect(swept).toBeGreaterThan(previous);
      previous = swept;
      // The chord sits at the waterline: both ends share a y, above the middle.
      expect(Math.sin(from)).toBeCloseTo(Math.sin(to), 10);
      expect(Math.sin(from)).toBeLessThan(Math.sin((from + to) / 2));
    }
  });
});

describe("carryTickAngles", () => {
  it("draws nothing for a body that has been emptied", () => {
    expect(carryTickAngles(0)).toEqual([]);
    expect(carryTickAngles(-1)).toEqual([]);
  });

  it("centres every fan on north", () => {
    for (const count of [1, 2, 3, 5, 9]) {
      const angles = carryTickAngles(count);
      const mean = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
      expect(mean).toBeCloseTo(NORTH, 10);
    }
  });

  it("spaces ticks evenly and in order", () => {
    const angles = carryTickAngles(6);
    const gaps = angles.slice(1).map((angle, index) => angle - angles[index]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeCloseTo(gaps[0], 10);
    }
  });

  it("tightens instead of spilling out of the north arc", () => {
    // A full hold is nine items. The fan has to stay clear of the ring's gaps on
    // the diagonals, so past a point it packs tighter rather than opening wider.
    const wide = carryTickAngles(9);
    const span = wide[wide.length - 1] - wide[0];
    expect(span).toBeLessThanOrEqual(Math.PI * 0.62 + 1e-9);
    expect(span).toBeGreaterThan(Math.PI * 0.3);
    expect(carryTickAngles(40).at(-1)! - carryTickAngles(40)[0]).toBeLessThanOrEqual(Math.PI * 0.62 + 1e-9);
  });
});

describe("brokenRingArcs", () => {
  it("opens exactly one gap per break and covers the rest of the ring", () => {
    const gapSpan = Math.PI * 0.16;
    const arcs = brokenRingArcs(gapSpan);
    const covered = arcs.reduce((sum, [from, to]) => sum + (to - from), 0);
    expect(covered).toBeCloseTo(Math.PI * 2 - gapSpan * arcs.length, 10);
  });

  it("never leaves an arc running backwards across the wrap", () => {
    // The last arc crosses zero. Drawn from a `from` greater than its `to`, pixi
    // sweeps the long way and closes the ring the gaps exist to open.
    for (const [from, to] of brokenRingArcs()) {
      expect(to).toBeGreaterThan(from);
      expect(to - from).toBeLessThan(Math.PI);
    }
  });

  it("keeps the carry fan clear of every gap", () => {
    // The two marks have to be legible at once: ticks at north, gaps elsewhere.
    const arcs = brokenRingArcs();
    for (const angle of carryTickAngles(9)) {
      const normalized = (angle + Math.PI * 4) % (Math.PI * 2);
      const inside = arcs.some(([from, to]) => {
        const start = from % (Math.PI * 2);
        const end = start + (to - from);
        return (normalized >= start && normalized <= end)
          || (normalized + Math.PI * 2 >= start && normalized + Math.PI * 2 <= end);
      });
      expect(inside).toBe(true);
    }
  });
});
