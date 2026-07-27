import { describe, expect, it } from "vitest";
import { arrivalSparkline, metricStats, percentile, snapshotArrivalStats } from "./netgraph";

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

  it("reports metric percentiles and the observed maximum", () => {
    expect(metricStats([40, 10, 30, 20])).toEqual({ p50: 20, p90: 40, p99: 40, max: 40 });
    expect(metricStats([])).toEqual({ p50: 0, p90: 0, p99: 0, max: 0 });
  });
});
