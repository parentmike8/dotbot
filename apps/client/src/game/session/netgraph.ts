export type NetworkDebugStats = {
  snapshotIntervalsMs: number[];
  snapshotP50Ms: number;
  snapshotP90Ms: number;
  snapshotP99Ms: number;
  rttMs: number | null;
  interpolationDelayMs: number;
  bufferDepthSnapshots: number;
  predictionErrorPx: number;
  correctionsPerSecond: number;
  hitConfirmationMs: number | null;
  hitPredictedCount: number;
  hitConfirmedCount: number;
  hitUnconfirmedCount: number;
  hitPendingCount: number;
};

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

export function snapshotArrivalStats(values: readonly number[]): Pick<
  NetworkDebugStats,
  "snapshotP50Ms" | "snapshotP90Ms" | "snapshotP99Ms"
> {
  return {
    snapshotP50Ms: percentile(values, 0.5),
    snapshotP90Ms: percentile(values, 0.9),
    snapshotP99Ms: percentile(values, 0.99),
  };
}

export function arrivalSparkline(values: readonly number[], width = 32): string {
  if (values.length === 0) return "·";
  const bars = "▁▂▃▄▅▆▇█";
  return values.slice(-width).map((value) => {
    const normalized = Math.max(0, Math.min(1, value / 200));
    return bars[Math.min(bars.length - 1, Math.floor(normalized * bars.length))];
  }).join("");
}
