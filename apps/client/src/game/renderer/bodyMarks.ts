/**
 * Where the marks on a downed body go.
 *
 * Pixi-free on purpose, like `model/prism.ts`: the arithmetic that decides whether
 * a fan of ticks reads as centred, or a ring reads as broken, is the part that can
 * be wrong in a way a screenshot only hints at.
 */

import type { Vec2 } from "@dotbot/game/types";

/** Straight up. Screen y grows downward, so north is negative. */
export const NORTH = -Math.PI / 2;

/** Widest fan the carry ticks may open to, and the spacing they prefer. */
const CARRY_SPAN = Math.PI * 0.62;
const CARRY_STEP = Math.PI * 0.085;

/**
 * One angle per carried item, fanned across the body's north arc and centred on
 * north — so a body with one item left and a body with six read as the same mark
 * getting shorter, not as two different marks.
 *
 * The fan tightens rather than widening past `CARRY_SPAN`: a full hold has to stay
 * inside the north arc, or the ticks run into the ring's own gaps.
 */
export function carryTickAngles(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [NORTH];
  const step = Math.min(CARRY_STEP, CARRY_SPAN / (count - 1));
  const start = NORTH - (step * (count - 1)) / 2;
  return Array.from({ length: count }, (_, index) => start + index * step);
}

/**
 * The arc of a disc lying below a waterline, for a fill that rises from the
 * bottom. `level` runs 0 (empty) to 1 (full).
 *
 * Returns the arc bounding the filled segment — the rim the caller sweeps around
 * the bottom to close the fill. Screen y grows downward, so "below" is the arc
 * through +y and a full disc is the whole circle rather than a degenerate sliver.
 *
 * Its two ends are exactly the two ends of `waterlineSurface` at the same level.
 * They have to be: the fill is the surface joined to this arc, and a disagreement
 * of even a unit opens a notch in the liquid's edge.
 */
export function waterlineArc(level: number): [number, number] | null {
  if (level <= 0) return null;
  if (level >= 1) return [0, Math.PI * 2];
  // sin of the waterline angle: +1 at the bottom of the disc, -1 at the top.
  const sin = 1 - 2 * level;
  const angle = Math.asin(sin);
  return [angle, Math.PI - angle];
}

/** How far the surface rides off its own level, as a share of the radius. */
const WAVE_AMPLITUDE = 0.09;
/** Crests across the surface. Under two, so it swells rather than ripples. */
const WAVE_CRESTS = 1.5;
const WAVE_SAMPLES = 24;

/**
 * The surface of the liquid in a core, left to right across a unit disc centred
 * on the origin. Returns null when the core is empty or full, neither of which
 * has a surface.
 *
 * A straight chord is a fill level; a curved one is a liquid, and that difference
 * is the whole reason this exists. `phase` shifts the crests, so a caller that
 * ties it to the level gets a surface that moves as the core fills instead of a
 * shape frozen mid-slosh.
 *
 * Two things keep the polyline honest, and both are load-bearing:
 *
 *   - The wave is enveloped to nothing at both ends. That is what a meniscus does
 *     where it meets the glass, and it puts the ends exactly on the rim so they
 *     meet `waterlineArc`'s.
 *   - Every point is then clamped inside the disc anyway. The envelope alone does
 *     not get there: near the ends the rim curves away faster than the wave
 *     decays, so a crest just inboard of the left edge would sit outside the core
 *     entirely and the fill would bulge past its own silhouette.
 */
export function waterlineSurface(level: number, phase = 0): Vec2[] | null {
  if (level <= 0 || level >= 1) return null;
  const waterline = 1 - 2 * level;
  const halfChord = Math.sqrt(Math.max(0, 1 - waterline * waterline));
  // A narrow surface has less room to move, and scaling with the chord is also
  // what keeps a nearly-empty core from showing a wave taller than its own liquid.
  const amplitude = WAVE_AMPLITUDE * halfChord;

  const points: Vec2[] = [];
  for (let index = 0; index <= WAVE_SAMPLES; index += 1) {
    const t = index / WAVE_SAMPLES;
    const x = -halfChord + 2 * halfChord * t;
    const envelope = Math.sin(Math.PI * t);
    const y = waterline + amplitude * envelope * Math.sin(phase + t * WAVE_CRESTS * Math.PI * 2);
    const bound = Math.sqrt(Math.max(0, 1 - x * x));
    points.push({ x, y: Math.min(bound, Math.max(-bound, y)) });
  }
  return points;
}

/**
 * The footprint ring, broken into arcs.
 *
 * A downed body is walkable — bots pass straight over it — and the contract is
 * blunt about what a closed dark outline promises: solid. So the ring that says
 * "a body is lying here" is drawn open, and the gaps are the part that carries the
 * meaning.
 *
 * The breaks are east, south and west. North stays whole because that is where the
 * body's contents are written, and a gap under the carry fan would read as a
 * missing tick rather than as an opening.
 */
export function brokenRingArcs(gapSpan = Math.PI * 0.16): Array<[number, number]> {
  const gapCenters = [0, Math.PI * 0.5, Math.PI];
  const arcs: Array<[number, number]> = [];
  for (let index = 0; index < gapCenters.length; index += 1) {
    const from = gapCenters[index] + gapSpan / 2;
    const to = gapCenters[(index + 1) % gapCenters.length] - gapSpan / 2;
    arcs.push([from, to < from ? to + Math.PI * 2 : to]);
  }
  return arcs;
}
