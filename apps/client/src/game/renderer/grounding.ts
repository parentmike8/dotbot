import type { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";

/**
 * Shared grounding primitives for the gameplay layer.
 *
 * Dots and DotBots are the only coloured things in the world, so they are the
 * only things that can look like UI floating over it. A flattened contact shadow
 * and a single upper-left catch light are what keep them reading as objects
 * lying on the floor. Both live here so the game renderer and the style lab
 * cannot drift apart on the look that was approved.
 */

/** Sun matches the world language: north-west, high, short shadows. */
const STEPS = [
  { grow: 3.4, dy: 4.6, alpha: 0.05 },
  { grow: 1.8, dy: 3.4, alpha: 0.07 },
  { grow: 0.4, dy: 2.4, alpha: 0.1 },
] as const;

/**
 * The shadow a standing body casts. Flattened on purpose: a circle at the
 * body's own radius reads as a plate it is standing on rather than as shadow.
 */
export function drawGroundShadow(g: Graphics, at: Vec2, radius: number, fade = 1): void {
  for (const step of STEPS) {
    g.ellipse(at.x + 1.2, at.y + step.dy, radius * 0.66 + step.grow, radius * 0.5 + step.grow)
      .fill({ color: 0x000000, alpha: step.alpha * fade });
  }
}

/** Upper-left catch light, so a filled circle reads as a sphere. */
export function drawCatchLight(g: Graphics, at: Vec2, radius: number, alpha = 0.34): void {
  g.circle(at.x - radius * 0.34, at.y - radius * 0.4, radius * 0.32).fill({ color: 0xffffff, alpha });
}
