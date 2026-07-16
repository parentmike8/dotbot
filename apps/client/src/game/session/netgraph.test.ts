import { describe, expect, it } from "vitest";
import { arrivalSparkline, percentile, snapshotArrivalStats } from "./netgraph";

describe("netgraph metrics", () => {
  it("computes nearest-rank arrival percentiles", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(snapshotArrivalStats(values)).toEqual({
      snapshotP50Ms: 50,
      snapshotP90Ms: 90,
      snapshotP99Ms: 99,
    });
  });

  it("renders a bounded newest-first arrival window", () => {
    expect(arrivalSparkline([])).toBe("·");
    expect(arrivalSparkline([0, 50, 100, 150, 200], 3)).toBe("▅▇█");
  });
});
