import { percentile } from "./netgraph";

export const minimumInterpolationDelayMs = 75;
export const maximumInterpolationDelayMs = 125;
export const interpolationWarmupSamples = 20;

/**
 * Keeps two snapshots available on a stable 20 Hz stream, then adds the
 * measured p90 arrival slack. TCP/WebSocket bursts appear as a long interval
 * followed by near-zero intervals, so the upper percentile is intentional.
 */
export function targetInterpolationDelayMs(
  intervalsMs: readonly number[],
  snapshotIntervalMs = 50,
): number {
  if (intervalsMs.length < interpolationWarmupSamples) return maximumInterpolationDelayMs;
  const recent = intervalsMs.slice(-120);
  const p90 = percentile(recent, 0.9);
  const arrivalSlack = Math.max(0, p90 - snapshotIntervalMs);
  return clamp(snapshotIntervalMs + 25 + arrivalSlack, minimumInterpolationDelayMs, maximumInterpolationDelayMs);
}

/** Rise quickly when the link becomes bursty; release latency slowly when it
 * settles so the render clock never sees a sudden forward jump. */
export function advanceInterpolationDelayMs(
  currentMs: number,
  targetMs: number,
  elapsedMs: number,
): number {
  const ratePerSecond = targetMs > currentMs ? 180 : 12;
  const maximumStep = ratePerSecond * Math.max(0, Math.min(elapsedMs, 250)) / 1000;
  if (Math.abs(targetMs - currentMs) <= maximumStep) return targetMs;
  return currentMs + Math.sign(targetMs - currentMs) * maximumStep;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
