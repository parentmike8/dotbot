import { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { INK } from "./style";

export type PerspectiveDotGeometry = {
  iconCenter: Vec2;
  shadowY: number;
  orbCenterY: number;
  orbRadiusX: number;
  orbRadiusY: number;
};

export function perspectiveDotGeometry(center: Vec2, radius: number): PerspectiveDotGeometry {
  return {
    iconCenter: { x: center.x, y: center.y - radius * 0.2 },
    shadowY: center.y + radius * 0.72,
    orbCenterY: center.y - radius * 0.08,
    orbRadiusX: radius,
    orbRadiusY: radius * 0.9,
  };
}

/** Shared visual primitive for collectible and environment Dots. Pixel-city
 * Dots are raised orbs grounded in the same shallow 3/4 plane as the
 * environment. The icon is drawn separately on the bright upper face. */
export function drawDotDisc(
  g: Graphics,
  center: Vec2,
  radius: number,
  color: number,
  perspective = false,
): void {
  if (!perspective) {
    // Grounded disc: a contact shadow, a shaded lower hemisphere and one
    // upper-left specular. A flat filled circle reads as a HUD token rather
    // than an object lying on the floor, which is what the plan theme shipped.
    g.circle(center.x + 1.4, center.y + 2.6, radius * 0.9).fill({ color: 0x000000, alpha: 0.1 });
    g.circle(center.x + 0.8, center.y + 1.5, radius * 0.82).fill({ color: 0x000000, alpha: 0.15 });
    g.circle(center.x, center.y, radius).fill({ color });
    g.circle(center.x, center.y, radius).stroke({ color: INK.structure, width: 2 });
    g.circle(center.x, center.y + radius * 0.34, radius * 0.7).fill({ color: INK.structure, alpha: 0.16 });
    // Before the caller's item mark, so the mark stays crisp on top.
    g.circle(center.x - radius * 0.3, center.y - radius * 0.34, radius * 0.3)
      .fill({ color: 0xffffff, alpha: 0.6 });
    return;
  }

  const geometry = perspectiveDotGeometry(center, radius);

  // The soft ground contact establishes height without changing the Dot's
  // collection radius or its authored position.
  g.ellipse(center.x + radius * 0.08, geometry.shadowY, radius * 1.02, radius * 0.3)
    .fill({ color: 0x080b10, alpha: 0.3 });

  // A dark lower shell peeks below the coloured orb and makes the object read
  // as volume instead of a flat token.
  g.ellipse(center.x, geometry.orbCenterY + radius * 0.2, radius * 0.94, radius * 0.88)
    .fill({ color: INK.structure, alpha: 0.96 });
  g.ellipse(center.x, geometry.orbCenterY, geometry.orbRadiusX, geometry.orbRadiusY)
    .fill({ color })
    .stroke({ color: INK.structure, width: 2 });

  // Lower hemisphere shade plus a small upper-left specular highlight. The
  // item mark is rendered after these layers and therefore stays crisp.
  g.ellipse(center.x, geometry.orbCenterY + radius * 0.48, radius * 0.76, radius * 0.3)
    .fill({ color: INK.structure, alpha: 0.2 });
  g.ellipse(center.x - radius * 0.28, geometry.orbCenterY - radius * 0.38, radius * 0.28, radius * 0.17)
    .fill({ color: 0xffffff, alpha: 0.62 });
  g.ellipse(center.x, geometry.orbCenterY - radius * 0.14, radius * 0.72, radius * 0.58)
    .stroke({ color: 0xffffff, width: 1, alpha: 0.24 });
}
