export type CanopyValueRamp = {
  under: number;
  body: number;
  crown: number;
  rimShade: number;
  rimLight: number;
};

/**
 * Larger crowns need more value range, not more marks.
 *
 * The forest trees are nearly twice the diameter of a street tree. Giving both
 * the same three tones made the large crowns read as expanded cauliflower. This
 * size-aware ramp opens the dark underside and lit crown while the lobe and fringe
 * counts stay capped, so added scale buys depth rather than visual noise.
 */
export function canopyValueRamp(radius: number): CanopyValueRamp {
  const size = Math.max(0, Math.min(1, (radius - 30) / 30));
  return {
    under: 0.61 - size * 0.11,
    body: 0.84 + size * 0.04,
    crown: 1 + size * 0.1,
    rimShade: 0.6 - size * 0.08,
    rimLight: 0.83 + size * 0.08,
  };
}
