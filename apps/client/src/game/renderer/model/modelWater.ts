import { Container, Graphics } from "pixi.js";
import type { MapDocument } from "@dotbot/game/types";
import { waterBodies } from "@dotbot/game/water";
import { drawWaterStreaks, waterHeld } from "./modelGround";
import { jitter } from "./tone";

/**
 * WATER THAT MOVES — the first ambient motion in the world, and the cheapest kind.
 *
 * `docs/world-motion.md` names this as the first real use, and it draws the line the
 * implementation follows: ambient motion is a pure function of the CLIENT CLOCK. It
 * touches no simulation state, is never replicated, and if two players see slightly
 * different frames of it, nothing is wrong.
 *
 * IT BREATHES, IT DOES NOT FLOW, and that is a decision rather than a shortcut. Every
 * body of water in the world so far is standing — a cenote, a flooded shaft, a cistern —
 * and a scrolling surface says current, which would be a lie about all of them. It also
 * saves the one genuinely awkward problem a scroll has: a translation has to wrap, and a
 * wrap has a seam. An oscillation has neither.
 *
 * TWO LAYERS IN OPPOSITE PHASE, because one layer moving rigidly reads as a sheet sliding
 * over a hole. Against each other, at different periods and amplitudes, the surface reads
 * as undulating: different parts of it are moving differently at any instant, which is the
 * whole of what "water" looks like from above.
 *
 * The cost is two container transforms per body per frame and nothing redrawn — the same
 * pattern the roof parallax already proved. The geometry is built once.
 */

export type WaterSurface = {
  id: string;
  /** Drifting highlight layers. The renderer moves these; it never redraws them. */
  layers: Container[];
  /** Per-body phase, so two pools on one sheet are never in lockstep. */
  phase: number;
};

/** How far a highlight layer wanders from its resting place, in world units. */
const SWAY = [6.5, 5] as const;
/** Milliseconds per cycle. Deliberately not multiples of each other. */
const PERIOD = [
  { x: 5400, y: 7300 },
  { x: 6100, y: 4700 },
] as const;

export function buildWaterSurfaces(map: MapDocument): { view: Container; surfaces: WaterSurface[] } {
  const view = new Container();
  const surfaces: WaterSurface[] = [];

  for (const body of waterBodies(map)) {
    const held = waterHeld(body.points);
    if (held.length < 3) continue;

    const layers: Container[] = [];
    for (let index = 0; index < 2; index += 1) {
      const streaks = new Graphics();
      // A different salt per layer, so the two sets of highlights are in different places
      // rather than one being the other with an offset — which would read as a double image.
      drawWaterStreaks(streaks, held, body.id, index * 137, index === 0 ? 9 : 7);

      /**
       * Masked to the water itself.
       *
       * Not an optional tidiness: these layers MOVE, so a streak near the edge would
       * otherwise drift out over the bank and read as a scratch on the stone. The mask is
       * the held ring, which is the same shape the streaks were laid out in.
       */
      const clip = new Graphics();
      clip.poly(held.map((point) => ({ x: point.x, y: point.y }))).fill({ color: 0xffffff });

      const layer = new Container();
      layer.addChild(streaks);
      const holder = new Container();
      holder.addChild(layer, clip);
      holder.mask = clip;
      view.addChild(holder);
      layers.push(layer);
    }

    surfaces.push({ id: body.id, layers, phase: jitter(body.id, 17) * Math.PI * 2 });
  }

  return { view, surfaces };
}

/**
 * Move every surface for this frame. One transform per layer; nothing is redrawn.
 *
 * `reducedMotion` parks everything at rest rather than slowing it down. That setting is
 * somebody's access requirement, not a taste control, and a slower undulation is still an
 * undulation.
 */
export function driftWater(surfaces: readonly WaterSurface[], nowMs: number, reducedMotion: boolean): void {
  for (const surface of surfaces) {
    for (let index = 0; index < surface.layers.length; index += 1) {
      const layer = surface.layers[index];
      if (reducedMotion) {
        layer.position.set(0, 0);
        layer.alpha = 1;
        continue;
      }
      // Opposite sign on the second layer: the two sets of highlights pass through each
      // other rather than travelling together.
      const sign = index === 0 ? 1 : -1;
      const period = PERIOD[index];
      const sway = SWAY[index];
      layer.position.set(
        Math.sin(nowMs / period.x + surface.phase) * sway * sign,
        Math.cos(nowMs / period.y + surface.phase * 1.7) * sway * 0.7 * sign,
      );
      // A slow breathe on top of the drift, so a highlight catches and loses the light
      // instead of only sliding. Never below 0.55: at zero the layer pops out of existence.
      layer.alpha = 0.78 + Math.sin(nowMs / 3100 + surface.phase * 2.3 + index) * 0.22;
    }
  }
}
