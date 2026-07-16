import type { InputCommand, Vec2 } from "@dotbot/game";
import { LitePredictor, type PredictedOwnBot } from "./LitePredictor";

export type PendingInput = {
  seq: number;
  input: InputCommand;
};

export type CorrectionKind = "adopt" | "blend" | "snap";

export function dropAcknowledgedInputs(pending: readonly PendingInput[], ack: number): PendingInput[] {
  return pending.filter(({ seq }) => seq > ack);
}

/**
 * Tick-exact reconciliation. The server consumes exactly one input frame per
 * simulation tick in seq order and acks the last frame it applied, so
 * replaying every pending frame (seq > ack) — one predictor step each — on
 * top of the authoritative state reproduces the server's future exactly.
 * Corrections therefore only appear for genuinely server-side information
 * (hits, knockback, channel freezes, other bots), never for transport jitter.
 */
export function replayPendingInputs(
  predictor: LitePredictor,
  authoritative: PredictedOwnBot,
  history: readonly PendingInput[],
  ack: number,
): { corrected: PredictedOwnBot; history: PendingInput[] } {
  const remaining = dropAcknowledgedInputs(history, ack).sort((a, b) => a.seq - b.seq);
  predictor.reset(authoritative);
  for (const { input } of remaining) {
    predictor.step(input);
  }
  return { corrected: predictor.current, history: remaining };
}

export function classifyCorrection(errorDistance: number, snapDistance = 150, blendThreshold = 0.5): CorrectionKind {
  if (errorDistance < blendThreshold) {
    return "adopt";
  }
  if (errorDistance > snapDistance) {
    return "snap";
  }
  return "blend";
}

export function decayCorrectionOffset(offset: Vec2, blendRate = 0.3, maxPerFrame = 6): Vec2 {
  const distance = Math.hypot(offset.x, offset.y);
  if (distance < 0.01) return { x: 0, y: 0 };
  const applied = Math.min(maxPerFrame, distance * blendRate);
  const remaining = Math.max(0, distance - applied) / distance;
  return { x: offset.x * remaining, y: offset.y * remaining };
}

export function preventBackwardMotion(previous: Vec2 | null, candidate: Vec2, inputMove: Vec2): Vec2 {
  if (!previous) return candidate;
  const magnitude = Math.hypot(inputMove.x, inputMove.y);
  if (magnitude <= 0.05) return candidate;
  const direction = { x: inputMove.x / magnitude, y: inputMove.y / magnitude };
  const delta = { x: candidate.x - previous.x, y: candidate.y - previous.y };
  const along = delta.x * direction.x + delta.y * direction.y;
  if (along >= 0) return candidate;
  return {
    x: candidate.x - direction.x * along,
    y: candidate.y - direction.y * along,
  };
}
