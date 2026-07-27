import { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { INK } from "./style";

/**
 * The shared Dot primitive, used for both collectible and environment Dots.
 *
 * A grounded disc, not a flat filled circle: contact shadow, shaded lower
 * hemisphere, one upper-left specular. Flat fill reads as a HUD token floating
 * over the map rather than an object lying on the floor.
 *
 * The caller draws the item mark afterwards, so it stays crisp on top.
 */
export function drawDotDisc(g: Graphics, center: Vec2, radius: number, color: number): void {
  g.circle(center.x + 1.4, center.y + 2.6, radius * 0.9).fill({ color: 0x000000, alpha: 0.1 });
  g.circle(center.x + 0.8, center.y + 1.5, radius * 0.82).fill({ color: 0x000000, alpha: 0.15 });
  g.circle(center.x, center.y, radius).fill({ color });
  g.circle(center.x, center.y, radius).stroke({ color: INK.structure, width: 2 });
  g.circle(center.x, center.y + radius * 0.34, radius * 0.7).fill({ color: INK.structure, alpha: 0.16 });
  g.circle(center.x - radius * 0.3, center.y - radius * 0.34, radius * 0.3)
    .fill({ color: 0xffffff, alpha: 0.6 });
}
