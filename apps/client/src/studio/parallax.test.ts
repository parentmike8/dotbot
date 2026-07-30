import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { buildMapArt } from "../game/renderer/mapArt";
import { OBJECT_PARALLAX_REDRAW_STEP, redrawOutdoorObjects } from "../game/renderer/model/modelParallax";
import { StudioParallax } from "./parallax";

describe("Studio production parallax parity", () => {
  it("uses the production outdoor handles and redraw behavior", () => {
    const gameArt = buildMapArt(downtownMap);
    const studioArt = buildMapArt(downtownMap);
    const centre = { x: 1200, y: 800 };
    const visible = { x: 700, y: 400, w: 1000, h: 800 };
    const studio = new StudioParallax();

    redrawOutdoorObjects(gameArt.outdoorObjectViews, centre, 1, visible);
    const stats = studio.update(studioArt, centre, visible, 1);

    expect(stats?.redrawn).toBeGreaterThan(0);
    for (const [id, gameHandle] of gameArt.outdoorObjectViews) {
      const studioHandle = studioArt.outdoorObjectViews.get(id)!;
      expect(studioHandle.elevated.position.x).toBeCloseTo(gameHandle.elevated.position.x);
      expect(studioHandle.elevated.position.y).toBeCloseTo(gameHandle.elevated.position.y);
    }
  });

  it("honors the same camera threshold while panning and zooming", () => {
    const art = buildMapArt(downtownMap);
    const studio = new StudioParallax();
    const visible = { x: 700, y: 400, w: 1000, h: 800 };
    expect(studio.update(art, { x: 1200, y: 800 }, visible, 1)).not.toBeNull();
    expect(studio.update(
      art,
      { x: 1200 + OBJECT_PARALLAX_REDRAW_STEP - 1, y: 800 },
      visible,
      1,
    )).toBeNull();
    expect(studio.update(
      art,
      { x: 1200 + OBJECT_PARALLAX_REDRAW_STEP, y: 800 },
      visible,
      1,
    )).not.toBeNull();

    // Zoom changes the visible world bounds without moving its centre. Studio
    // invalidates its camera cache on zoom so the production redraw still runs.
    studio.invalidate();
    expect(studio.update(
      art,
      { x: 1200 + OBJECT_PARALLAX_REDRAW_STEP, y: 800 },
      { x: 850, y: 500, w: 700, h: 600 },
      1,
    )).not.toBeNull();
  });
});
