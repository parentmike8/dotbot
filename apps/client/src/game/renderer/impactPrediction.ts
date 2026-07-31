import { buildContactShape, contactDistance, contactingPlate, makeContactShape } from "@dotbot/game/bodyContact";
import { CORE_REACH, coveringPlate, plateContactAngle, plateSum, reseatPlates, restoreShieldPlate } from "@dotbot/game/shields";
import type { DotBotEntity, GameSnapshot, HitResult, Vec2 } from "@dotbot/game/types";
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

export type SourceContactPresentation = {
  position: Vec2;
  weight: number;
};

export const impactReactionDurationMs = 150;

/**
 * A hit is swept and adjudicated before nearby solid resolution can move the
 * attacker away. For the short live impact beat, put the attacking body back
 * at the exact contact the shared geometry accepted, then release smoothly to
 * its authoritative post-solid position.
 */
export function impactContactForSource(
  impacts: readonly QueuedPredictedImpact[],
  source: DotBotEntity,
  snapshot: GameSnapshot,
  nowMs: number,
): SourceContactPresentation | null {
  const impact = [...impacts].reverse().find((candidate) =>
    candidate.kind === "hit"
      && candidate.sourceId === source.id
      && nowMs - candidate.startedAt >= 0
      && nowMs - candidate.startedAt <= impactReactionDurationMs);
  if (!impact) return null;
  const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
  if (!target) return null;

  const length = Math.hypot(impact.direction.x, impact.direction.y);
  const fallback = normalized({
    x: source.position.x - target.position.x,
    y: source.position.y - target.position.y,
  });
  const fromTargetToSource = length > 0.001
    ? { x: -impact.direction.x / length, y: -impact.direction.y / length }
    : fallback;
  const targetSegments = [...target.shieldSegments];
  if (impact.result === "plateBreak") restoreShieldPlate(targetSegments);
  const targetShape = makeContactShape(target.maxShields);
  const sourceShape = makeContactShape(source.maxShields);
  buildContactShape(targetShape, target.radius, target.facing, targetSegments);
  buildContactShape(sourceShape, source.radius, source.facing, source.shieldSegments);
  const touching = contactDistance(
    targetShape,
    sourceShape,
    fromTargetToSource.x,
    fromTargetToSource.y,
    0,
  );
  return {
    position: {
      x: target.position.x + fromTargetToSource.x * touching,
      y: target.position.y + fromTargetToSource.y * touching,
    },
    weight: 1 - (nowMs - impact.startedAt) / impactReactionDurationMs,
  };
}

export function classifyPredictedImpact(snapshot: GameSnapshot, impact: Pick<PredictedImpact, "targetId" | "sourceId" | "x" | "y">): HitResult {
  const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
  if (!target || target.state !== "alive") return "plateBreak";
  return predictedContactPlate(snapshot, target, impact) === null ? "downed" : "plateBreak";
}

export function predictedImpactDirection(
  snapshot: GameSnapshot,
  impact: Pick<PredictedImpact, "targetId" | "sourceId" | "x" | "y">,
): Vec2 {
  const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
  if (!target) return { x: 0, y: 0 };
  const source = snapshot.bots.find((bot) => bot.id === impact.sourceId);
  return normalized({
    x: target.position.x - (source?.position.x ?? impact.x),
    y: target.position.y - (source?.position.y ?? impact.y),
  });
}

/** Immediate predicted effect point, using the same plate/core surface as authority. */
export function predictedImpactPosition(
  snapshot: GameSnapshot,
  impact: Pick<PredictedImpact, "targetId" | "sourceId" | "x" | "y">,
): Vec2 {
  const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
  if (!target) return { x: impact.x, y: impact.y };
  const source = snapshot.bots.find((bot) => bot.id === impact.sourceId);
  const dx = (source?.position.x ?? impact.x) - target.position.x;
  const dy = (source?.position.y ?? impact.y) - target.position.y;
  const impactAngle = Math.atan2(dy, dx);
  const plate = predictedContactPlate(snapshot, target, impact);
  const contactAngle = plate === null
    ? impactAngle
    : plateContactAngle(target.facing, target.shieldSegments.length, plate, impactAngle);
  const radius = target.radius * (plate === null ? CORE_REACH : 1);
  return {
    x: target.position.x + Math.cos(contactAngle) * radius,
    y: target.position.y + Math.sin(contactAngle) * radius,
  };
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
    (candidate.targetId === targetId || (candidate.kind !== "hit" && candidate.sourceId === targetId))
      && nowMs - candidate.startedAt >= 0
      && nowMs - candidate.startedAt <= impactReactionDurationMs);
  if (!impact) return null;
  const progress = Math.min(1, (nowMs - impact.startedAt) / impactReactionDurationMs);
  const impulse = Math.sin(Math.PI * progress);
  const isSource = impact.sourceId === targetId;
  const direction = isSource
    ? { x: -impact.direction.x, y: -impact.direction.y }
    : impact.direction;
  const distance = impulse * (
    reducedMotion
      ? 4
      : impact.kind === "clash"
        ? 14
        : impact.kind === "bump"
          ? 8
          : impact.result === "downed"
            ? 14
            : 10
  );
  const sign = direction.x < 0 ? -1 : 1;
  return {
    offset: { x: direction.x * distance, y: direction.y * distance },
    scale: reducedMotion ? 1 : 1 - impulse * (
      impact.kind === "clash"
        ? 0.09
        : impact.kind === "bump"
          ? 0.045
          : impact.result === "downed"
            ? 0.12
            : 0.075
    ),
    rotation: reducedMotion ? 0 : sign * impulse * (
      impact.kind === "clash"
        ? 0.07
        : impact.kind === "bump"
          ? 0.025
          : impact.result === "downed"
            ? 0.09
            : 0.045
    ),
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
    if (impact.kind !== "hit") continue;
    const target = snapshot.bots.find((bot) => bot.id === impact.targetId);
    if (!target || target.state !== "alive") continue;

    if (!impact.baselineShieldSegments || !impact.predictedShieldSegments) {
      impact.baselineShieldSegments = [...target.shieldSegments];
      impact.predictedShieldSegments = [...target.shieldSegments];
      const plate = predictedContactPlate(snapshot, target, impact);
      if (plate !== null) {
        impact.predictedShieldSegments[plate] = 0;
        reseatPlates(impact.predictedShieldSegments);
      }
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

/** Client mirror of the authoritative finite-body plate witness. */
function predictedContactPlate(
  snapshot: GameSnapshot,
  target: DotBotEntity,
  impact: Pick<PredictedImpact, "sourceId" | "x" | "y">,
): number | null {
  const source = snapshot.bots.find((bot) => bot.id === impact.sourceId);
  if (source) {
    const dx = source.position.x - target.position.x;
    const dy = source.position.y - target.position.y;
    const dist = Math.hypot(dx, dy);
    const ux = dist > 0.001 ? dx / dist : 1;
    const uy = dist > 0.001 ? dy / dist : 0;
    const targetShape = makeContactShape(target.maxShields);
    const sourceShape = makeContactShape(source.maxShields);
    buildContactShape(targetShape, target.radius, target.facing, target.shieldSegments);
    buildContactShape(sourceShape, source.radius, source.facing, source.shieldSegments);
    return contactingPlate(
      targetShape,
      target.facing,
      target.shieldSegments,
      sourceShape,
      ux,
      uy,
    );
  }

  // Rolling snapshots can briefly lack source metadata. Preserve the old
  // centre-angle fallback for that compatibility case only.
  const impactAngle = Math.atan2(impact.y - target.position.y, impact.x - target.position.x);
  const plate = coveringPlate(target.facing, target.shieldSegments.length, impactAngle);
  return target.shieldSegments[plate] > 0 ? plate : null;
}

function sameSegments(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalized(vector: Vec2): Vec2 {
  const length = Math.hypot(vector.x, vector.y);
  return length > 0.0001 ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 0 };
}
