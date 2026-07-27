import { applyShieldHit, plateSum } from "@dotbot/game/shields";
import type { GameSnapshot, HitResult, Vec2 } from "@dotbot/game/types";
import type { PredictedImpact } from "../session/GameSession";

export const predictedImpactHoldMs = 220;

export type QueuedPredictedImpact = PredictedImpact & {
  startedAt: number;
  result: HitResult;
  direction: Vec2;
  confirmedAt?: number;
  baselineShieldSegments?: number[];
  predictedShieldSegments?: number[];
};

export type ImpactReaction = {
  offset: Vec2;
  scale: number;
  rotation: number;
};

export const impactReactionDurationMs = 150;

export function classifyPredictedImpact(snapshot: GameSnapshot, impact: Pick<PredictedImpact, "targetId" | "x" | "y">): HitResult {
  const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
  if (!target || target.state !== "alive") return "bodyHit";
  const segments = [...target.shieldSegments];
  const impactAngle = Math.atan2(impact.y - target.position.y, impact.x - target.position.x);
  const hit = applyShieldHit(target.facing, segments, impactAngle);
  if (plateSum(segments) <= 0) return "downed";
  return hit.direct ? "plateBreak" : "bodyHit";
}

export function predictedImpactDirection(
  snapshot: GameSnapshot,
  impact: Pick<PredictedImpact, "targetId" | "x" | "y">,
): Vec2 {
  const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
  if (!target) return { x: 0, y: 0 };
  return normalized({ x: target.position.x - impact.x, y: target.position.y - impact.y });
}

/** Visual-only victim response on the same delayed body the attacker touched.
 * It returns to zero as the authoritative knockback enters the timeline. */
export function impactReactionForTarget(
  impacts: readonly QueuedPredictedImpact[],
  targetId: string,
  nowMs: number,
  reducedMotion: boolean,
): ImpactReaction | null {
  const impact = [...impacts].reverse().find((candidate) =>
    candidate.targetId === targetId && nowMs - candidate.startedAt >= 0
      && nowMs - candidate.startedAt <= impactReactionDurationMs);
  if (!impact) return null;
  const progress = Math.min(1, (nowMs - impact.startedAt) / impactReactionDurationMs);
  const impulse = Math.sin(Math.PI * progress);
  const distance = impulse * (reducedMotion ? 4 : impact.result === "downed" ? 14 : 10);
  const sign = impact.direction.x < 0 ? -1 : 1;
  return {
    offset: { x: impact.direction.x * distance, y: impact.direction.y * distance },
    scale: reducedMotion ? 1 : 1 - impulse * (impact.result === "downed" ? 0.12 : 0.075),
    rotation: reducedMotion ? 0 : sign * impulse * (impact.result === "downed" ? 0.09 : 0.045),
  };
}

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

function normalized(vector: Vec2): Vec2 {
  const length = Math.hypot(vector.x, vector.y);
  return length > 0.0001 ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 0 };
}
