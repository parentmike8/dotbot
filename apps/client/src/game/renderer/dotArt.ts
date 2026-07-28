import { Graphics } from "pixi.js";
import type { Item, Vec2 } from "@dotbot/game/types";
import { INK } from "./style";
import { strokeArc } from "./bodies";

/**
 * The shared Dot primitive, used for both collectible and environment Dots.
 *
 * A grounded disc, not a flat filled circle: contact shadow, shaded lower
 * hemisphere, one upper-left specular. Flat fill reads as a HUD token floating
 * over the map rather than an object lying on the floor.
 *
 * Draw a Dot in three calls, in this order:
 *
 *   drawDotDisc(g, at, r, colour);
 *   drawDotMark(g, item, at, r);
 *   drawDotGloss(g, at, r);
 *
 * The gloss goes *last*, over the mark. It used to be part of the disc, with the
 * mark painted on afterwards — so a dark glyph landed square on the highlight and
 * flattened a sphere back into a token with a symbol stamped on it. A specular is
 * a property of the surface, and light lands on whatever is painted there.
 */
export function drawDotDisc(g: Graphics, center: Vec2, radius: number, color: number): void {
  g.circle(center.x + 1.4, center.y + 2.6, radius * 0.9).fill({ color: 0x000000, alpha: 0.1 });
  g.circle(center.x + 0.8, center.y + 1.5, radius * 0.82).fill({ color: 0x000000, alpha: 0.15 });
  g.circle(center.x, center.y, radius).fill({ color });
  g.circle(center.x, center.y, radius).stroke({ color: INK.structure, width: 2 });
  g.circle(center.x, center.y + radius * 0.34, radius * 0.7).fill({ color: INK.structure, alpha: 0.16 });
}

/** The upper-left specular, drawn over everything painted on the Dot. */
export function drawDotGloss(g: Graphics, center: Vec2, radius: number): void {
  g.circle(center.x - radius * 0.3, center.y - radius * 0.34, radius * 0.3)
    .fill({ color: 0xffffff, alpha: 0.6 });
}

/**
 * What kind of Dot this is, as a mark on its face.
 *
 * Lives here rather than in the renderer, because the style lab draws Dots too —
 * and while this was private to the game the lab drew bare spheres with no marks
 * on them. A review surface that renders a thing the game never renders is not a
 * review surface.
 */
export function drawDotMark(g: Graphics, item: Item, center: Vec2, radius: number): void {
  const size = Math.max(3.5, radius * 0.42);
  const line = { color: INK.structure, width: Math.max(1.25, radius * 0.14) };
  const { x, y } = center;

  if (item.kind === "blueprint") {
    g.moveTo(x - size, y - size * 0.55).lineTo(x + size, y - size * 0.55)
      .moveTo(x - size, y).lineTo(x + size * 0.45, y)
      .moveTo(x - size, y + size * 0.55).lineTo(x + size, y + size * 0.55).stroke(line);
    return;
  }
  if (item.kind === "mine") {
    g.moveTo(x - size, y - size).lineTo(x + size, y + size)
      .moveTo(x + size, y - size).lineTo(x - size, y + size).stroke(line);
    return;
  }
  if (item.type === "health") {
    g.moveTo(x - size, y).lineTo(x + size, y).moveTo(x, y - size).lineTo(x, y + size).stroke(line);
    return;
  }
  if (item.type === "radar") {
    strokeArc(g, center, size * 0.5, -Math.PI * 0.75, Math.PI * 0.75, { ...line, alpha: 1 });
    strokeArc(g, center, size, -Math.PI * 0.75, Math.PI * 0.75, { ...line, alpha: 1 });
    return;
  }
  if (item.type === "dashOvercharge") {
    g.moveTo(x - size * 0.65, y - size)
      .lineTo(x + size * 0.45, y)
      .lineTo(x - size * 0.65, y + size)
      .stroke(line);
    return;
  }
  for (let index = 0; index < 8; index += 2) {
    strokeArc(g, center, size, (index * Math.PI) / 4, ((index + 1) * Math.PI) / 4, { ...line, alpha: 1 });
  }
}
