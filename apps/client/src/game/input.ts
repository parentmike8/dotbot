import { add, normalizeInputVector, zeroVec } from "@dotbot/game/math";
import type { InputCommand, Vec2 } from "@dotbot/game/types";

export const movementKeyCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function createEmptyInputCommand(): InputCommand {
  return {
    move: zeroVec(),
    dash: false,
  };
}

export function getKeyboardVector(keys: ReadonlySet<string>): Vec2 {
  let move = zeroVec();

  if (keys.has("KeyW") || keys.has("ArrowUp")) {
    move = add(move, { x: 0, y: -1 });
  }

  if (keys.has("KeyS") || keys.has("ArrowDown")) {
    move = add(move, { x: 0, y: 1 });
  }

  if (keys.has("KeyA") || keys.has("ArrowLeft")) {
    move = add(move, { x: -1, y: 0 });
  }

  if (keys.has("KeyD") || keys.has("ArrowRight")) {
    move = add(move, { x: 1, y: 0 });
  }

  return normalizeInputVector(move);
}

export function mergeMoveVectors(primary: Vec2, secondary: Vec2): Vec2 {
  return normalizeInputVector(add(primary, secondary));
}
