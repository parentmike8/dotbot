import type { Rect, Vec2 } from "@dotbot/game/types";
import type { MapArt } from "../game/renderer/mapArt";
import {
  OBJECT_PARALLAX_REDRAW_STEP,
  redrawOutdoorObjects,
  type ParallaxRedrawStats,
} from "../game/renderer/model/modelParallax";

/**
 * Studio camera state around the production outdoor parallax redraw.
 *
 * This owns no geometry and no alternate parallax law. It only applies the
 * live-game camera threshold before calling `redrawOutdoorObjects` on the
 * production `MapArt` handles.
 */
export class StudioParallax {
  private lastCentre: Vec2 = { x: Number.NaN, y: Number.NaN };

  invalidate(): void {
    this.lastCentre = { x: Number.NaN, y: Number.NaN };
  }

  update(
    art: MapArt,
    centre: Vec2,
    visibleBounds: Rect,
    strength: number,
  ): ParallaxRedrawStats | null {
    const moved = Math.hypot(
      centre.x - this.lastCentre.x,
      centre.y - this.lastCentre.y,
    );
    if (moved < OBJECT_PARALLAX_REDRAW_STEP) return null;
    this.lastCentre = { ...centre };
    return redrawOutdoorObjects(
      art.outdoorObjectViews,
      centre,
      strength,
      visibleBounds,
    );
  }
}
