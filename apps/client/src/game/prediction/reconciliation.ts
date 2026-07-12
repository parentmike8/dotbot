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

export function replayPendingInputs(
  predictor: LitePredictor,
  authoritative: PredictedOwnBot,
  pending: readonly PendingInput[],
  ack: number,
): { corrected: PredictedOwnBot; pending: PendingInput[] } {
  const remaining = dropAcknowledgedInputs(pending, ack);
  predictor.reset(authoritative);

  for (const entry of remaining) {
    predictor.step(entry.input);
    // Inputs are sent at about 30Hz against the 60Hz sim. The dash edge is
    // consumed on the first replay tick and must never be banked or repeated.
    predictor.step({ ...entry.input, dash: false });
  }

  return { corrected: predictor.current, pending: remaining };
}

export function classifyCorrection(errorDistance: number, botRadius: number): CorrectionKind {
  if (errorDistance < botRadius * 0.5) {
    return "adopt";
  }
  if (errorDistance > botRadius * 3) {
    return "snap";
  }
  return "blend";
}

export function blendOffset(offset: Vec2, elapsedMs: number, durationMs = 100): Vec2 {
  const remaining = Math.max(0, 1 - elapsedMs / durationMs);
  if (remaining === 0) {
    return { x: 0, y: 0 };
  }
  return { x: offset.x * remaining, y: offset.y * remaining };
}
