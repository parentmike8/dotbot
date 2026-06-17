import type { Vec2 } from "./types";

export const zeroVec = (): Vec2 => ({ x: 0, y: 0 });

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, scalar: number): Vec2 {
  return { x: v.x * scalar, y: v.y * scalar };
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return length(subtract(a, b));
}

export function normalize(v: Vec2): Vec2 {
  const magnitude = length(v);

  if (magnitude <= 0.0001) {
    return zeroVec();
  }

  return { x: v.x / magnitude, y: v.y / magnitude };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function colorToNumber(color: string): number {
  return Number.parseInt(color.replace("#", ""), 16);
}

export function normalizeInputVector(move: Vec2): Vec2 {
  return normalize({
    x: clamp(move.x, -1, 1),
    y: clamp(move.y, -1, 1),
  });
}
