/**
 * Ink for the gameplay overlay.
 *
 * The world itself is drawn by `model/` from `model/tone.ts`, which owns every
 * value and light decision in the lit model. This file is the much smaller
 * palette for the layer *over* the world: bots, Dots, progress rings, noise
 * rings, impact marks, extraction pulses, map labels.
 *
 * It used to be the whole drawing system — a pen-plotter plan on white paper with
 * a five-tier line hierarchy — and the tier names survive because the overlay
 * still needs a range of weights and the relative ordering is still what keeps it
 * from out-shouting the world underneath. What is gone is the claim that these
 * values describe the map.
 *
 * Colour is reserved for gameplay. The world is achromatic; anything chromatic on
 * screen is something the player can act on.
 */

/** Pure white, for overlay chips and markers that sit above the world. */
export const OVERLAY_WHITE = 0xffffff;

/** Ink values, darkest to lightest. Neutral greys — no blue cast. */
export const INK = {
  /** Heaviest: bot cores, hulls, impact bursts. */
  structure: 0x17191c,
  /** Rings and arcs that need to read at a glance. */
  opening: 0x33373c,
  anchor: 0x3d4247,
  /** Secondary marks and map labels. */
  fixture: 0x7d838a,
  /** Hairline: chip borders, faint annotation. */
  hairline: 0xb9bec4,
  glass: 0xe3e7ea,
  plate: 0xf4f5f6,
} as const;

/** Permanent semantic dot palette. Keep interaction neutral and world items chromatic. */
export const DOT_COLOR = {
  powerup: 0xe8590c,
  blueprint: 0x1971c2,
  interaction: INK.hairline,
} as const;

/** Stroke widths in world units. One place, so relative weight stays honest. */
export const WEIGHT = {
  structure: 2.6,
  opening: 1.8,
  anchor: 1.5,
  fixture: 1.0,
  hairline: 0.7,
} as const;
