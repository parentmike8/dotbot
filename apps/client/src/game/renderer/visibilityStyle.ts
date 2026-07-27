export type VisibilityFogStyle = {
  color: number;
  alpha: number;
};

/**
 * The wash over space the player cannot currently see.
 *
 * Indoors and outdoors want different weights for the same reason a floor plan
 * and a street map do: an unseen room has to read as genuinely unknown, so it
 * takes a real veil. Outdoors the player can already see most of the street from
 * the camera alone, and a heavy wash there just looks like weather rather than
 * ignorance — so it stays a hint.
 */
export function visibilityFogStyle(indoors: boolean): VisibilityFogStyle {
  return {
    color: 0x2f353b,
    alpha: indoors ? 0.18 : 0.035,
  };
}
