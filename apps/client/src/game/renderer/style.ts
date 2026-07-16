/**
 * The DotBot drawing system: a monochrome architectural plan on bright white
 * paper, rendered as if by a pen plotter.
 *
 * Every mark on the map belongs to exactly one tier of a strict hierarchy.
 * Lower tiers must never out-shout higher ones — if a secondary fixture reads
 * before a wall, the drawing is wrong. Nothing here casts shadows, blends
 * gradients, or imitates materials; weight and value carry all meaning.
 *
 *   T1 structure    — building shells, party walls, cores. Solid near-black poché.
 *   T2 opening      — doors, windows, stairs, curbs at crossings. Strong dark line.
 *   T3 anchor       — beds, desks, racks: the furniture that names a room.
 *   T4 fixture      — chairs, sinks, small equipment. Fine gray line.
 *   T5 annotation   — hatches, thresholds, swings, lane dashes, labels. Hairline.
 *
 * Color is reserved for gameplay (bots, dots, extraction) and never appears in
 * the base drawing.
 */

export const PAPER = 0xffffff;

/** Ink values, darkest to lightest. Neutral grays — no blue cast. */
export const INK = {
  /** T1: wall poché, building outlines. */
  structure: 0x17191c,
  /** T2: door leaves, stair treads/arrows, window frames. */
  opening: 0x33373c,
  /** T3: anchor furniture outlines. */
  anchor: 0x3d4247,
  /** T4: secondary fixture linework. */
  fixture: 0x7d838a,
  /** T5: annotation, hatching, thresholds, swings. */
  hairline: 0xb9bec4,
  /** Glazing: the one permitted flat fill besides white. */
  glass: 0xe3e7ea,
  /** Quiet plate tint for stair runs and roof decks. */
  plate: 0xf4f5f6,
} as const;

/** Permanent semantic dot palette. Keep interaction neutral and world items chromatic. */
export const DOT_COLOR = {
  powerup: 0xe8590c,
  blueprint: 0x1971c2,
  interaction: INK.fixture,
} as const;

/** Stroke widths in world units (map px). One place, so tiers stay honest. */
export const WEIGHT = {
  structure: 2.6,
  opening: 1.8,
  anchor: 1.5,
  fixture: 1.0,
  hairline: 0.7,
} as const;

export type StrokeStyle = { color: number; width: number; alpha?: number };

export const strokes = {
  structure: { color: INK.structure, width: WEIGHT.structure } as StrokeStyle,
  opening: { color: INK.opening, width: WEIGHT.opening } as StrokeStyle,
  anchor: { color: INK.anchor, width: WEIGHT.anchor } as StrokeStyle,
  fixture: { color: INK.fixture, width: WEIGHT.fixture } as StrokeStyle,
  hairline: { color: INK.hairline, width: WEIGHT.hairline } as StrokeStyle,
} as const;
