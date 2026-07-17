export const hitConfirmationTimeoutMs = 750;

type PendingHit = {
  targetId: string;
  predictedAtMs: number;
};

export type ImpactTelemetry = {
  pending: PendingHit[];
  lastConfirmationMs: number | null;
  predictedCount: number;
  confirmedCount: number;
  unconfirmedCount: number;
};

export function createImpactTelemetry(): ImpactTelemetry {
  return {
    pending: [],
    lastConfirmationMs: null,
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
): void {
  expireUnconfirmedHits(telemetry, nowMs);
  telemetry.pending.push({ targetId, predictedAtMs: nowMs });
  telemetry.predictedCount += 1;
}

/** Correlates an explicit server hit acknowledgement with the oldest local
 * prediction against that target. Hits by other players are deliberately
 * ignored, so unrelated shield changes cannot produce a false confirmation. */
export function recordAuthoritativeHit(
  telemetry: ImpactTelemetry,
  event: { botId: string; byBotId: string },
  playerId: string,
  nowMs: number,
): void {
  expireUnconfirmedHits(telemetry, nowMs);
  if (event.byBotId !== playerId) return;
  const index = telemetry.pending.findIndex((pending) => pending.targetId === event.botId);
  if (index < 0) return;
  const [pending] = telemetry.pending.splice(index, 1);
  telemetry.lastConfirmationMs = Math.max(0, nowMs - pending.predictedAtMs);
  telemetry.confirmedCount += 1;
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
