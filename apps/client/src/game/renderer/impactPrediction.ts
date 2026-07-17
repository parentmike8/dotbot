import { applyShieldHit, plateSum } from "@dotbot/game/shields";
import type { GameSnapshot } from "@dotbot/game/types";
import type { PredictedImpact } from "../session/GameSession";

export const predictedImpactHoldMs = 220;

export type QueuedPredictedImpact = PredictedImpact & {
  startedAt: number;
  baselineShieldSegments?: number[];
  predictedShieldSegments?: number[];
};

/**
 * Locally previews the shield response for a dash contact while the server's
 * authoritative result is in flight. The overlay is deliberately bounded:
 * an authoritative segment change wins immediately, and an unconfirmed
 * prediction disappears after a short rollback window.
 */
export function applyPredictedImpactOverlays(
  snapshot: GameSnapshot,
  impacts: QueuedPredictedImpact[],
  nowMs: number,
): GameSnapshot {
  const overlays = new Map<string, number[]>();

  for (const impact of impacts) {
    const ageMs = nowMs - impact.startedAt;
    if (ageMs < 0 || ageMs > predictedImpactHoldMs) continue;
    const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
    if (!target || target.state !== "alive") continue;

    if (!impact.baselineShieldSegments || !impact.predictedShieldSegments) {
      impact.baselineShieldSegments = [...target.shieldSegments];
      impact.predictedShieldSegments = [...target.shieldSegments];
      const impactAngle = Math.atan2(impact.y - target.position.y, impact.x - target.position.x);
      applyShieldHit(target.facing, impact.predictedShieldSegments, impactAngle);
    }

    // A real server result has arrived. Never apply the speculative hit again
    // on top of it; the authoritative combat state now owns the presentation.
    if (!sameSegments(target.shieldSegments, impact.baselineShieldSegments)) continue;
    overlays.set(target.id, impact.predictedShieldSegments);
  }

  if (overlays.size === 0) return snapshot;
  return {
    ...snapshot,
    bots: snapshot.bots.map((bot) => {
      const segments = overlays.get(bot.id);
      return segments
        ? { ...bot, shieldSegments: [...segments], shields: plateSum(segments) }
        : bot;
    }),
  };
}

function sameSegments(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
