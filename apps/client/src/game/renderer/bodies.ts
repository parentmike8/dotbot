import type { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { INK, WEIGHT } from "./style";
import { brokenRingArcs, carryTickAngles } from "./bodyMarks";

/**
 * The one arc primitive. Pixi's `arc` continues the current path, so an arc drawn
 * without moving to its own start joins the previous stroke with a chord.
 */
export function strokeArc(
  g: Graphics,
  at: Vec2,
  radius: number,
  from: number,
  to: number,
  style: { color: number; width: number; alpha?: number },
): void {
  g.moveTo(at.x + Math.cos(from) * radius, at.y + Math.sin(from) * radius);
  g.arc(at.x, at.y, radius, from, to).stroke(style);
}

/**
 * The same arc on an ellipse. Pixi has no elliptical arc, and the shape matters
 * here — a flattened ring is what makes a body read as lying down rather than as
 * one more circle in a world already full of them.
 */
function strokeEllipseArc(
  g: Graphics,
  at: Vec2,
  rx: number,
  ry: number,
  from: number,
  to: number,
  style: { color: number; width: number; alpha?: number },
): void {
  const steps = Math.max(4, Math.ceil((Math.abs(to - from) / (Math.PI * 2)) * 48));
  for (let step = 0; step <= steps; step += 1) {
    const t = from + ((to - from) * step) / steps;
    const point = { x: at.x + Math.cos(t) * rx, y: at.y + Math.sin(t) * ry };
    if (step === 0) g.moveTo(point.x, point.y);
    else g.lineTo(point.x, point.y);
  }
  g.stroke(style);
}

export type DownedBody = {
  at: Vec2;
  radius: number;
  /** Squad relationship colour — whose body this is, at the same glance as everything else. */
  color: number;
  /** Public even for rivals: how much is still on it. Composition is not. */
  carriedCount: number;
  /** A loot channel has finished here, so the contents are known and takeable. */
  searched: boolean;
};

/**
 * A body lying on the floor.
 *
 * It used to be drawn as a standing bot turned down: a cast shadow, thin plate
 * arcs still anchored to a facing, and an interaction dot at the centre in the
 * engraved floor-mark vocabulary — which read as a drain in the middle of the room.
 *
 * Three things the drawing has to say, and nothing else:
 *
 *   - It is *down*. A standing bot floats above an offset cast shadow; this one has
 *     a flat contact pool directly under it, because nothing is lifted. And it is
 *     drawn flattened — the one shape in a world of circles that is not one, for
 *     the same reason the ground shadow is squashed rather than round.
 *   - It is *walkable*. Bots pass straight over a body, and per the contract a
 *     dark closed outline is the world's promise of solid — so the ring is drawn
 *     open at east, south and west.
 *   - It is *worth something*, or it is not. One tick per carried item across the
 *     north arc, and a filled interior until somebody searches it: full means
 *     there is a channel to run here, bare means someone already did.
 */
const SQUASH = 0.7;

export function drawDownedBody(g: Graphics, body: DownedBody): void {
  const { at, radius, color } = body;
  const rx = radius * 0.88;
  const ry = rx * SQUASH;

  // Contact pool: no offset and no stack, because a body touching the floor
  // everywhere has no gap for light to get under. The ring lies just inside it.
  g.ellipse(at.x, at.y, radius * 0.96, radius * 0.96 * SQUASH).fill({ color: 0x000000, alpha: 0.09 });

  // Unsearched bodies hold something you cannot see yet. The wash is the closed
  // lid; searching it leaves bare floor inside the ring.
  if (!body.searched) {
    g.ellipse(at.x, at.y, rx * 0.86, ry * 0.86).fill({ color, alpha: 0.14 });
  }

  // The body, open where you would step over it. Structural ink under the
  // relationship colour, because an ambient grey body drawn only in its own colour
  // is a light-grey line on a light-grey floor.
  for (const [from, to] of brokenRingArcs()) {
    strokeEllipseArc(g, at, rx, ry, from, to, { color: INK.structure, width: WEIGHT.anchor + 1.4, alpha: 0.2 });
    strokeEllipseArc(g, at, rx, ry, from, to, { color, width: WEIGHT.anchor, alpha: 0.95 });
  }

  // What is left on it. Ticks read inward from the ring, so an emptied body is
  // plainly emptier rather than merely dimmer.
  for (const angle of carryTickAngles(body.carriedCount)) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    g.moveTo(at.x + cos * rx * 0.6, at.y + sin * ry * 0.6)
      .lineTo(at.x + cos * (rx - 2), at.y + sin * (ry - 2))
      .stroke({ color: INK.structure, width: WEIGHT.anchor, alpha: 0.85 });
  }
}
