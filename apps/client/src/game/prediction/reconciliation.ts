import type { InputCommand, Vec2 } from "@dotbot/game";
import { LitePredictor, type PredictedOwnBot } from "./LitePredictor";

export type PendingInput = {
  seq: number;
  input: InputCommand;
  /** Client prediction tick when this input frame became the latest latch. */
  predictionTick: number;
};

export type CorrectionKind = "adopt" | "blend" | "snap";

export function dropAcknowledgedInputs(pending: readonly PendingInput[], ack: number): PendingInput[] {
  return pending.filter(({ seq }) => seq > ack);
}

export function retainInputHistory(history: readonly PendingInput[], ack: number): PendingInput[] {
  const acknowledged = history.filter(({ seq }) => seq <= ack).at(-1);
  return [...(acknowledged ? [acknowledged] : []), ...dropAcknowledgedInputs(history, ack)];
}

export function replayPendingInputs(
  predictor: LitePredictor,
  authoritative: PredictedOwnBot,
  history: readonly PendingInput[],
  ack: number,
  authoritativeTick: number,
  predictionTick: number,
  fallbackLatched: InputCommand = { move: { x: 0, y: 0 }, dash: false },
): { corrected: PredictedOwnBot; pending: PendingInput[]; history: PendingInput[] } {
  const ordered = [...history].sort((a, b) => a.predictionTick - b.predictionTick || a.seq - b.seq);
  const acknowledged = ordered.filter(({ seq }) => seq <= ack).at(-1);
  const remaining = ordered.filter(({ seq }) => seq > ack);
  let latched = acknowledged?.input ?? fallbackLatched;
  let nextIndex = 0;
  predictor.reset(authoritative);

  for (let tick = authoritativeTick + 1; tick <= predictionTick; tick += 1) {
    let receivedNewInput = false;
    while (remaining[nextIndex] && remaining[nextIndex].predictionTick <= tick) {
      latched = remaining[nextIndex].input;
      nextIndex += 1;
      receivedNewInput = true;
    }
    predictor.step(receivedNewInput ? latched : withoutConsumedEdges(latched));
  }

  return {
    corrected: predictor.current,
    pending: remaining,
    history: [...(acknowledged ? [acknowledged] : []), ...remaining],
  };
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

function withoutConsumedEdges(input: InputCommand): InputCommand {
  return {
    move: input.move,
    dash: false,
    downedVerb: input.downedVerb,
  };
}
