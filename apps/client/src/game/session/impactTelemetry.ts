export const hitConfirmationTimeoutMs = 750;

export type PendingHit = {
  predictionId: string;
  targetId: string;
  predictedAtMs: number;
  presentedAtMs?: number;
};

export type ImpactTelemetry = {
  pending: PendingHit[];
  lastConfirmationMs: number | null;
  lastPresentationMs: number | null;
  confirmationSamplesMs: number[];
  presentationSamplesMs: number[];
  predictedCount: number;
  confirmedCount: number;
  unconfirmedCount: number;
};

export function createImpactTelemetry(): ImpactTelemetry {
  return {
    pending: [],
    lastConfirmationMs: null,
    lastPresentationMs: null,
    confirmationSamplesMs: [],
    presentationSamplesMs: [],
    predictedCount: 0,
    confirmedCount: 0,
    unconfirmedCount: 0,
  };
}

/** Records the moment the local presentation showed contact. */
export function recordPredictedHit(
  telemetry: ImpactTelemetry,
  targetId: string,
  nowMs: number,
  predictionId = `impact-${telemetry.predictedCount + 1}`,
): string {
  expireUnconfirmedHits(telemetry, nowMs);
  telemetry.pending.push({ predictionId, targetId, predictedAtMs: nowMs });
  telemetry.predictedCount += 1;
  return predictionId;
}

export function recordPresentedHit(
  telemetry: ImpactTelemetry,
  predictionId: string,
  nowMs: number,
): void {
  const pending = telemetry.pending.find((candidate) => candidate.predictionId === predictionId);
  if (!pending || pending.presentedAtMs !== undefined) return;
  pending.presentedAtMs = nowMs;
  const duration = Math.max(0, nowMs - pending.predictedAtMs);
  telemetry.lastPresentationMs = duration;
  pushBounded(telemetry.presentationSamplesMs, duration);
}

/** Correlates an explicit server hit acknowledgement with the oldest local
 * prediction against that target. Hits by other players are deliberately
 * ignored, so unrelated shield changes cannot produce a false confirmation. */
export function recordAuthoritativeHit(
  telemetry: ImpactTelemetry,
  event: { botId: string; byBotId: string },
  playerId: string,
  nowMs: number,
): PendingHit | null {
  expireUnconfirmedHits(telemetry, nowMs);
  if (event.byBotId !== playerId) return null;
  const index = telemetry.pending.findIndex((pending) => pending.targetId === event.botId);
  if (index < 0) return null;
  const [pending] = telemetry.pending.splice(index, 1);
  telemetry.lastConfirmationMs = Math.max(0, nowMs - pending.predictedAtMs);
  pushBounded(telemetry.confirmationSamplesMs, telemetry.lastConfirmationMs);
  telemetry.confirmedCount += 1;
  return pending;
}

/** "Unconfirmed" means no acknowledgement arrived inside the bounded
 * 750ms correlation window. It intentionally does not claim why. */
export function expireUnconfirmedHits(telemetry: ImpactTelemetry, nowMs: number): void {
  const stillPending: PendingHit[] = [];
  for (const pending of telemetry.pending) {
    if (nowMs - pending.predictedAtMs > hitConfirmationTimeoutMs) {
      telemetry.unconfirmedCount += 1;
    } else {
      stillPending.push(pending);
    }
  }
  telemetry.pending = stillPending;
}

function pushBounded(values: number[], value: number): void {
  values.push(value);
  if (values.length > 128) values.splice(0, values.length - 128);
}
