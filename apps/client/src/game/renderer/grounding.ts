import type { Graphics } from "pixi.js";
import type { Vec2 } from "@dotbot/game/types";
import { contactReach } from "@dotbot/game/shields";
import { SHADOW_ALPHA } from "./model/tone";

/**
 * Shared grounding primitives for the gameplay layer, and the silhouette every
 * one of them is cut to.
 *
 * Dots and DotBots are the only coloured things in the world, so they are the
 * only things that can look like UI floating over it. A soft contact shadow and a
 * single upper-left catch light are what keep them reading as objects lying on
 * the floor. Both live here so the game renderer and the style lab cannot drift
 * apart on the look that was approved.
 *
 * The silhouette helpers live here too, rather than next to the body drawing that
 * also uses them, because this is the leaf: `bodies.ts` imports grounding and
 * never the reverse, and the shadow is the first thing that needs to know what
 * shape a body actually is.
 */

/** Sun vector, matching the world language exactly: north-west, high, short. */
const SUN = { x: 0.3, y: 0.62 };

/** How far the sun throws per unit of lift. */
const SUN_THROW = Math.hypot(SUN.x, SUN.y);

/**
 * Apparent height of a body, in the same units as the world's `LIFT` scale — a
 * shade under a wall, a shade over a crate.
 */
const BODY_LIFT = 8;

/** How much of the body's own reach the darkest, tightest step covers. */
const SHADOW_CONTACT = 0.82;

/** Widest offset multiplier the ramp reaches, at its faintest step. */
const SHADOW_SPREAD_MAX = 1.95;

/**
 * How far the softest step of the penumbra grows past the body's own reach.
 *
 * A shadow is the one mark that may legitimately fall outside the collider — that
 * is what a shadow *is* — so it needs a declared allowance rather than the flat
 * "nothing outside `contactReach`" every other primitive lives under.
 */
export const SHADOW_PENUMBRA = BODY_LIFT * 1.1;

/**
 * The whole allowance: how far any shadow ink may sit outside `contactReach`,
 * counting both the penumbra's growth and the sun's throw. 19.54 units, and the
 * number `grounding.test.ts` holds the shadow to.
 */
export const SHADOW_ALLOWANCE = SHADOW_PENUMBRA + SUN_THROW * BODY_LIFT * SHADOW_SPREAD_MAX;

/** One arc of a body's silhouette: constant reach across an angular span. */
export type SilhouetteCell = { from: number; to: number; radius: number };

/** What the silhouette needs to know. A `DotBotEntity` satisfies it. */
export type SilhouetteBody = {
  radius: number;
  facing: number;
  shieldSegments: number[];
};

/**
 * The body's real outline, as arcs: one per plate, at that plate's reach.
 *
 * `contactReach` is piecewise constant — a plate owns its whole *Voronoi* cell,
 * seams included, so the shape is exactly `maxShields` arcs joined by radial
 * steps. Nothing here approximates: sampling this on a fixed angular grid would
 * round the corners off the one feature that matters, the bite where a plate is
 * gone.
 *
 * `adjust` maps a reach to the radius to draw at, which is how a stroke pulls in
 * by half its width and how the shadow ramps outward.
 */
export function silhouetteCells(
  body: SilhouetteBody,
  adjust: (reach: number) => number = (reach) => reach,
): SilhouetteCell[] {
  const plates = body.shieldSegments.length;

  if (plates <= 0) {
    const radius = adjust(contactReach(body.radius, body.facing, body.shieldSegments, 0));
    return [{ from: body.facing - Math.PI, to: body.facing + Math.PI, radius }];
  }

  const step = (Math.PI * 2) / plates;
  const cells: SilhouetteCell[] = [];
  for (let index = 0; index < plates; index += 1) {
    const center = body.facing + index * step;
    cells.push({
      from: center - step / 2,
      to: center + step / 2,
      radius: adjust(contactReach(body.radius, body.facing, body.shieldSegments, center)),
    });
  }
  return cells;
}

/**
 * Lay the silhouette down as one closed path, ready to stroke or fill.
 *
 * Pixi's `arc` runs a line in from wherever the path already is, so consecutive
 * cells at different radii join with exactly the radial step the body has there —
 * the jamb comes free, and cells at equal radii produce a plain circle.
 */
export function traceSilhouette(g: Graphics, at: Vec2, cells: SilhouetteCell[]): void {
  const first = cells[0];
  g.moveTo(at.x + Math.cos(first.from) * first.radius, at.y + Math.sin(first.from) * first.radius);
  for (const cell of cells) g.arc(at.x, at.y, cell.radius, cell.from, cell.to);
  g.closePath();
}

/**
 * Turn a world-space direction into the frame a rotated body is drawn in.
 *
 * A bot's body Graphics is drawn once at facing 0 and its container is then spun
 * by the facing, which is what keeps a turning bot from redrawing every frame.
 * Anything that encodes a *world* direction — the sun, above all — has to be
 * counter-spun by that same rotation or it rides around with the bot. That was
 * the bug: the cast shadow orbited its own bot on a 5-unit radius, 21.5 units of
 * travel across a half-turn, which reads as the body juddering even on ticks when
 * nothing moved.
 */
export function unspin(vector: Vec2, spin: number): Vec2 {
  const cos = Math.cos(spin);
  const sin = Math.sin(spin);
  return { x: vector.x * cos + vector.y * sin, y: -vector.x * sin + vector.y * cos };
}

/**
 * The shadow a standing body casts.
 *
 * This used to be three flattened ellipses at two-thirds the body's radius,
 * offset south. Two things were wrong with it and they compounded. A DotBot is
 * mostly not there — a hairline hull, three arcs and a core — so a mark drawn
 * inside its own outline is not *under* anything; it is a separate grey oval
 * sitting in the middle of the bot, plainly visible through it. And three steps
 * is not a falloff: `tone.ts` went to nine precisely because six still read as
 * concentric rings rather than as shade, and the bot layer never got the memo.
 *
 * So it is the world's own shadow now, at the world's own ramp, offset along the
 * shared sun vector. The comment it replaces worried that a circle at the body's
 * radius would read as a plate the bot stands on, which was the right observation
 * and the wrong fix — what makes a plate is the hard edge, not the size. Nine
 * steps have no edge to read.
 *
 * It is the body's *shape* now rather than a circle, which for a fully plated bot
 * is the same drawing it always was and for a stripped one is a third the size.
 * A disc under a bot whose sides have receded to the core is the same lie the
 * plate ghost told, in grey: two bare bots resting at their true 19.20 put 20.16
 * units of full-strength shade through each other, and in a clump the discs
 * summed into one welded mass.
 */
export function drawGroundShadow(
  g: Graphics,
  at: Vec2,
  body: SilhouetteBody,
  options: { fade?: number; spin?: number } = {},
): void {
  const fade = options.fade ?? 1;
  const sun = unspin(SUN, options.spin ?? 0);

  for (let step = 0; step < SHADOW_ALPHA.length; step += 1) {
    const t = step / (SHADOW_ALPHA.length - 1);
    const spread = 0.45 + t * 1.5;
    const cells = silhouetteCells(body, (reach) => reach * SHADOW_CONTACT + t * SHADOW_PENUMBRA);
    traceSilhouette(
      g,
      { x: at.x + sun.x * BODY_LIFT * spread, y: at.y + sun.y * BODY_LIFT * spread },
      cells,
    );
    g.fill({ color: 0x000000, alpha: SHADOW_ALPHA[step] * fade });
  }
}

/**
 * Where the catch light sits, as a share of the radius.
 *
 * Up and to the left: the same north-west light the shadow is cast by, within
 * fifteen degrees. It is written as its own vector rather than derived from `SUN`
 * because it was placed by eye on the sphere and approved there.
 */
const CATCH = { x: -0.34, y: -0.4 };

/** Upper-left catch light, so a filled circle reads as a sphere. */
export function drawCatchLight(
  g: Graphics,
  at: Vec2,
  radius: number,
  alpha = 0.34,
  spin = 0,
): void {
  const offset = unspin(CATCH, spin);
  g.circle(at.x + offset.x * radius, at.y + offset.y * radius, radius * 0.32)
    .fill({ color: 0xffffff, alpha });
}
