import type { MapDocument } from "@dotbot/game/types";

export type VisibilityFogStyle = {
  color: number;
  alpha: number;
};

/** Keep hidden Pixel City space equally legible indoors and outdoors. */
export function visibilityFogStyle(
  visualTheme: MapDocument["visualTheme"],
  indoors: boolean,
): VisibilityFogStyle {
  if (visualTheme === "pixel-city") {
    return { color: 0x090c12, alpha: 0.62 };
  }

  return {
    color: 0x2f353b,
    alpha: indoors ? 0.18 : 0.035,
  };
}
