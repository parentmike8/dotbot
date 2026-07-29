import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";
import type { Rect } from "@dotbot/game/types";
import { buildMapArt } from "../game/renderer/mapArt";
import { selectMapDocument } from "../mapSelection";

/**
 * World lab: the production map, region by region, through the production renderer.
 *
 * It used to draw three candidate regions as mock vignettes — hand-placed `Graphics` with
 * no colliders, no map data and their own private copies of the palette. That was the right
 * tool for choosing a direction and the wrong one to keep: the regions are real map
 * documents now, so a second set of drawing code for the same places is a second source of
 * truth that can only drift. It is deleted, and this renders the real thing.
 *
 * Which is the whole point of a lab surface. `?solo` runs a match, and a match cannot be
 * screenshotted from a headless browser because the game loop needs a real frame clock.
 * This composes the same art with no simulation, no input and no netcode, so a region can
 * be redrawn and captured in one deterministic frame.
 *
 *   ?worlds                  the whole sheet, fitted
 *   ?worlds&pick=yard        one region, filling the view
 *   ?worlds&shots=1          write a PNG per region to tmp/lab/
 *   ?worlds&map=downtown     any map `mapSelection` knows
 */

/**
 * What to frame, and the frames ARE the regions.
 *
 * Deliberately a plain list of rectangles rather than anything derived: this is a review
 * tool, and "show me the fairground" wants a fixed, repeatable crop so two screenshots of
 * the same region can be compared. Nothing in the game reads it.
 */
const FRAMES: Array<{ id: string; title: string; rect: Rect; floorId?: string }> = [
  { id: "world", title: "The Reach", rect: { x: 0, y: 0, w: 4200, h: 3400 } },
  { id: "downtown", title: "Downtown", rect: { x: 0, y: 0, w: 2400, h: 1600 } },
  { id: "yard", title: "Fenchurch Yard", rect: { x: 2374, y: 0, w: 1826, h: 1800 } },
  { id: "fair", title: "The Pleasure Ground", rect: { x: 0, y: 1574, w: 2400, h: 1826 } },
  { id: "temple", title: "The Great Temple", rect: { x: 2374, y: 1774, w: 1826, h: 1626 } },
  // The two seams, close in. A transition is the one thing a region-sized crop cannot show.
  { id: "seam-yard", title: "Main St crosses into the yard", rect: { x: 1900, y: 380, w: 1400, h: 1100 } },
  { id: "seam-fair", title: "Third Ave runs out of the city", rect: { x: 700, y: 1200, w: 1300, h: 1100 } },
  /**
   * The attractions, close enough to judge one glyph at a time.
   *
   * A region crop is the wrong tool for the question "does this read as a big top", and
   * two rides were shipped four times each on the strength of region crops before anyone
   * looked at one on its own. These are at roughly play zoom.
   */
  { id: "rides-west", title: "Helter-skelter and carousel", rect: { x: 300, y: 1900, w: 1200, h: 750 } },
  { id: "rides-east", title: "The big top, at the end of the midway", rect: { x: 1700, y: 2400, w: 800, h: 700 } },
  /**
   * The temple's four levels, one frame each.
   *
   * The only surface that can show a floor below ground at all: `?worlds` draws the map's
   * GROUND stack, and the crypt and the undercroft are never on screen in a run unless you
   * have walked down to them. A `floor=` frame renders one named plan instead.
   */
  // Ids stay lowercase-and-dashes: the shot endpoint rejects anything else as an unsafe
  // filename, so `temple-B1` silently wrote nothing while reporting a frame rendered.
  { id: "temple-close", title: "The Great Temple, from the plaza", rect: { x: 2800, y: 1700, w: 1000, h: 1000 } },
  { id: "temple-crypt", title: "The crypt (B1)", rect: { x: 2900, y: 1740, w: 800, h: 820 }, floorId: "temple:B1" },
  { id: "temple-undercroft", title: "The undercroft (B2)", rect: { x: 2560, y: 2040, w: 1380, h: 1070 }, floorId: "temple:B2" },
  { id: "temple-summit", title: "The summit (ROOF)", rect: { x: 2900, y: 1740, w: 800, h: 820 }, floorId: "temple:ROOF" },
];

export function WorldLab() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const params = new URLSearchParams(window.location.search);
    const pick = params.get("pick");
    const shots = params.get("shots") === "1";
    let app: Application | null = null;
    let disposed = false;

    void (async () => {
      const created = new Application();
      await created.init({
        background: 0x6e7378,
        antialias: true,
        resolution: 1,
        autoDensity: false,
        width: host.clientWidth || 1600,
        height: host.clientHeight || 1000,
        preference: "webgl",
      });
      if (disposed) {
        created.destroy(true);
        return;
      }
      app = created;
      created.canvas.style.width = "100%";
      created.canvas.style.height = "100%";
      created.canvas.style.display = "block";
      host.appendChild(created.canvas);
      created.ticker.autoStart = false;
      created.ticker.stop();

      const map = selectMapDocument(window.location.search);
      const art = buildMapArt(map);

      /**
       * Every roof at rest.
       *
       * `buildRoofModel` hands back a `mass` container the game slides each frame to fake
       * parallax off the camera's own position. There is no camera here, so leaving it at
       * zero is the honest still: the silhouette drawn is exactly the footprint that blocks
       * you, which is the promise the parallax pass had to earn.
       */
      for (const building of art.buildings) {
        for (const mass of building.roofMasses) mass.position.set(0, 0);
      }

      const stage = new Container();
      stage.addChild(art.root);
      created.stage.addChild(stage);

      /**
       * Show one interior floor, for the frames that name one.
       *
       * `buildMapArt` builds every floor and hides all but GROUND, because in a run you only
       * ever see the plan you are standing on. That makes the levels below ground invisible
       * to every review surface there is — the crypt and the undercroft could not be looked
       * at at all without walking down to them in a live match. So a frame may name a floor,
       * and the roofs come off so the plan underneath is not covered by the mass above it.
       */
      const showFloor = (floorId: string | null): void => {
        for (const building of art.buildings) {
          for (const mass of building.roofMasses) mass.visible = floorId === null;
          building.roof.visible = floorId === null;
          for (const floor of building.floors) {
            floor.view.visible = floorId === null ? floor.floor.label === "GROUND" : floor.floor.id === floorId;
          }
        }
      };

      /** Fit a world rect to the canvas, with a little air round it. */
      const frame = (rect: Rect, width: number, height: number): void => {
        const pad = 0.985;
        const scale = Math.min(width / rect.w, height / rect.h) * pad;
        stage.scale.set(scale);
        stage.position.set(
          (width - rect.w * scale) / 2 - rect.x * scale,
          (height - rect.h * scale) / 2 - rect.y * scale,
        );
      };

      if (shots) {
        /**
         * One PNG per frame, each at a size that keeps the region legible.
         *
         * Capped at 2200 on the long edge: the whole sheet at 1:1 is a 14-megapixel canvas,
         * which some GPUs refuse and none of it needs — what a critique pass looks at is
         * composition and value, and both survive a downscale.
         */
        const results: string[] = [];
        for (const shot of FRAMES) {
          showFloor(shot.floorId ?? null);
          const long = Math.max(shot.rect.w, shot.rect.h);
          const scale = Math.min(1, 2200 / long);
          const width = Math.round(shot.rect.w * scale);
          const height = Math.round(shot.rect.h * scale);
          created.renderer.resize(width, height);
          frame(shot.rect, width, height);
          created.render();
          const png = created.canvas.toDataURL("image/png");
          const response = await fetch("/__lab/shot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: `map-${shot.id}`, png }),
          });
          const body = await response.json() as { ok?: boolean; error?: string };
          results.push(`${shot.id}: ${body.ok ? "ok" : `FAILED ${body.error ?? ""}`}`);
        }
        (window as unknown as { worldShots?: string[] }).worldShots = results;
        return;
      }

      const chosen = FRAMES.find((candidate) => candidate.id === pick) ?? FRAMES[0];
      showFloor(chosen.floorId ?? null);
      const draw = (): void => {
        created.renderer.resize(host.clientWidth, host.clientHeight);
        frame(chosen.rect, created.renderer.width, created.renderer.height);
        created.render();
      };
      draw();

      const observer = new ResizeObserver(draw);
      observer.observe(host);
      (created as unknown as { __observer?: ResizeObserver }).__observer = observer;
      void Graphics;
    })();

    return () => {
      disposed = true;
      const held = app as unknown as { __observer?: ResizeObserver } | null;
      held?.__observer?.disconnect();
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#6e7378" }} />;
}
