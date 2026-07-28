import { describe, expect, it } from "vitest";
import { NORTH, brokenRingArcs, carryTickAngles, waterlineArc, waterlineSurface } from "./bodyMarks";

const LEVELS = [0.02, 0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92, 0.99];
const PHASES = [0, 1, 2.5, 4, Math.PI * 2];

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

describe("waterlineSurface", () => {
  it("has no surface when the core is empty or full", () => {
    expect(waterlineSurface(0)).toBeNull();
    expect(waterlineSurface(-1)).toBeNull();
    expect(waterlineSurface(1)).toBeNull();
    expect(waterlineSurface(2)).toBeNull();
  });

  it("never leaves the unit disc, at any level or phase", () => {
    /**
     * The core's silhouette is its own radius, and liquid drawn outside the glass
     * is a burr on the rim rather than an obvious mistake — so it gets an
     * assertion rather than an eye.
     *
     * Swept, not sampled. A handful of tidy levels passed this with the containment
     * clamp deleted: the envelope holds the surface in on its own everywhere except
     * within a percent or so of empty, where the rim curves away faster than the
     * wave decays. That is exactly the case a short list of round numbers skips.
     */
    // Reduced to a single assertion over the worst point found. The same sweep
    // written as a quarter-million `expect` calls took six seconds and flaked
    // once under parallel load — a slow test is a test that eventually gets
    // deleted, and the sweep is the part worth keeping.
    let worst = 0;
    for (let step = 1; step < 400; step += 1) {
      const level = step / 400;
      for (let turn = 0; turn < 24; turn += 1) {
        const phase = (turn / 24) * Math.PI * 2;
        for (const point of waterlineSurface(level, phase)!) {
          worst = Math.max(worst, Math.hypot(point.x, point.y));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("runs left to right without doubling back", () => {
    // x must stay monotone or the closed fill crosses itself, and a self-crossing
    // path cancels its own fill — the failure that ate the cracked core twice.
    for (const level of LEVELS) {
      const points = waterlineSurface(level, 2)!;
      for (let i = 1; i < points.length; i += 1) {
        expect(points[i].x).toBeGreaterThan(points[i - 1].x);
      }
    }
  });

  it("meets the rim exactly where the closing arc starts and ends", () => {
    // The fill is this polyline joined to `waterlineArc`. If the two disagree the
    // liquid gets a notch at the waterline, so they are checked against each other
    // rather than each against its own idea of the level.
    for (const level of LEVELS) {
      for (const phase of PHASES) {
        const points = waterlineSurface(level, phase)!;
        const [from, to] = waterlineArc(level)!;
        const first = points[0];
        const last = points[points.length - 1];
        expect(last.x).toBeCloseTo(Math.cos(from), 10);
        expect(last.y).toBeCloseTo(Math.sin(from), 10);
        expect(first.x).toBeCloseTo(Math.cos(to), 10);
        expect(first.y).toBeCloseTo(Math.sin(to), 10);
      }
    }
  });

  it("rises as the core fills", () => {
    // Screen y grows downward, so a rising level means a smaller mean y. Without
    // this the gauge can be upside down and still pass every shape check above.
    let previous = Infinity;
    for (const level of LEVELS) {
      const points = waterlineSurface(level, 0)!;
      const mean = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      expect(mean).toBeLessThan(previous);
      previous = mean;
    }
  });

  it("waves: the surface is not the flat chord", () => {
    // The whole point of the shape. A straight line across a disc is a fill bar.
    const points = waterlineSurface(0.5, 1.2)!;
    const spread = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
    expect(spread).toBeGreaterThan(0.05);
  });

  it("keeps the wave inside the liquid it sits on", () => {
    // A crest taller than the fill itself would break the surface into islands at
    // a low charge. The amplitude has to shrink with the chord, not stay constant.
    for (const level of [0.02, 0.05, 0.1]) {
      const points = waterlineSurface(level, 1.2)!;
      const waterline = 1 - 2 * level;
      for (const point of points) expect(point.y).toBeLessThan(1);
      const rise = waterline - Math.min(...points.map((p) => p.y));
      expect(rise).toBeLessThan(level * 2);
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
