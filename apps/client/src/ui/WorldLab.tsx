import { useEffect, useRef } from "react";
import { Application, Container, Graphics } from "pixi.js";
import type { MapDocument, Rect, Vec2 } from "@dotbot/game/types";
import { objectSolids } from "@dotbot/game/collision";
import { groundAt, isSoftGround } from "@dotbot/game/ground";
import { buildMapArt, type MapArt } from "../game/renderer/mapArt";
import { redrawFloorObjects } from "../game/renderer/model/modelFloor";
import {
  parseObjectParallaxStrength,
  redrawOutdoorObjects,
  type ParallaxRedrawStats,
} from "../game/renderer/model/modelParallax";
import {
  animateAmbient, driftLeaves, fadeTrail, stampTrail, trailStep,
} from "../game/renderer/model/modelMotion";
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
 *   ?worlds&parallax=0.5     exact object-parallax review strength (0, .5, 1, 2)
 *   ?worlds&footprints=1     authoritative object collision footprints
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
  { id: "coaling-tower", title: "The coaling tower at native scale", rect: { x: 2370, y: 245, w: 470, h: 420 } },
  /**
   * The attractions, close enough to judge one glyph at a time.
   *
   * A region crop is the wrong tool for the question "does this read as a big top", and
   * two rides were shipped four times each on the strength of region crops before anyone
   * looked at one on its own. These are at roughly play zoom.
   */
  { id: "rides-west", title: "Swing ride and carousel", rect: { x: 300, y: 1900, w: 1200, h: 750 } },
  { id: "rides-east", title: "The big top, at the end of the midway", rect: { x: 1700, y: 2400, w: 800, h: 700 } },
  // The waltzer had no close crop of its own — it fell between `rides-west`, which stops
  // 90 units above it, and the region frame, where a 300-unit ride is a smudge. It is one
  // of the two things in the world that MOVES, so it needs a frame that can be watched.
  { id: "rides-south", title: "The waltzer, off the midway", rect: { x: 790, y: 2420, w: 680, h: 580 } },
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
  /**
   * The cenote, close in — the world's one body of water.
   *
   * A still frame cannot show the surface DRIFTING, and that is worth saying rather than
   * pretending: this is here to check the water's banks and highlights are intact, and the
   * motion has to be watched in a run. `modelWater.test.ts` covers the drift itself.
   */
  { id: "cenote", title: "The cenote", rect: { x: 3560, y: 1800, w: 700, h: 640 } },
  /**
   * The forest, close in, at roughly play zoom.
   *
   * `docs/world-motion.md` calls it "the largest sway surface in the world" and it had no
   * frame of its own: the region crop puts a 100-unit tree inside four pixels, which is
   * exactly the zoom at which a canopy leaning four units is invisible. Sway can only be
   * judged where a tree is bigger than a thumbnail.
   */
  { id: "temple-forest", title: "The forest, at play zoom", rect: { x: 3060, y: 2820, w: 768, h: 480 } },
];

/**
 * Air left round a floor crop, so the exterior wall and the ground outside a door are in
 * frame. A room judged with its doorway cropped off is a room judged without the one fact
 * that decides where the furniture belongs.
 */
const FLOOR_PAD = 70;

/**
 * A shot name the endpoint will accept, from any floor id.
 *
 * Floor ids are `mercy:F2` — a colon and capitals, both of which the shot endpoint rejects
 * as an unsafe filename. It rejects them into the results array rather than into a thrown
 * error, so the pass reports 43 frames rendered and writes 39 files, and the four missing
 * ones are the four nobody notices. `temple-B1` already cost a review cycle that way and
 * the fix at the time was to hand-author lowercase ids, which fixes the instance and leaves
 * the trap. Deriving the name means a new floor cannot fall into it.
 */
function shotName(floorId: string): string {
  return floorId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * One frame per interior floor, derived from the map.
 *
 * The hand-authored list above is right for what it does — a region crop is a composition
 * choice, and "show me the fairground" has to mean the same rectangle every time or two
 * screenshots cannot be compared. It is wrong as the ONLY way in: it had 4 of the world's 27
 * floors in it, the temple's four, added because a dungeon could not be reviewed otherwise.
 * The other 23 interiors had never been rendered as an image at all, which is the practical
 * reason "just look at the rooms" was not something anyone did — there was nothing to look
 * at, and every layout bug in them had to be found by walking into it.
 *
 * Derived from `floor.bounds`, which is the floor's own extent rather than the building's
 * bounding box. That distinction is the whole reason this is possible now: before `bounds`
 * existed, the only rectangle available for a floor was the footprint of the building around
 * it, so a stepped or fanned floor came out as a small plan adrift in a large empty crop.
 */
function floorFrames(map: MapDocument): Array<{ id: string; title: string; rect: Rect; floorId: string }> {
  const frames: Array<{ id: string; title: string; rect: Rect; floorId: string }> = [];
  for (const building of map.buildings) {
    for (const floor of building.floors) {
      const box = floor.bounds ?? building.footprint;
      frames.push({
        id: `floor-${shotName(floor.id)}`,
        title: `${building.name} — ${floor.label}`,
        rect: {
          x: box.x - FLOOR_PAD,
          y: box.y - FLOOR_PAD,
          w: box.w + FLOOR_PAD * 2,
          h: box.h + FLOOR_PAD * 2,
        },
        floorId: floor.id,
      });
    }
  }
  return frames;
}

type LabParallaxStats = {
  strength: number;
  outdoor: ParallaxRedrawStats;
  interiorRedrawn: number;
  durationMs: number;
};

/** Apply the same object pass the game uses, from the centre of this deterministic crop. */
function applyFrameParallax(
  art: MapArt,
  frame: { rect: Rect; floorId?: string },
  strength: number,
): LabParallaxStats {
  const started = performance.now();
  const centre = {
    x: frame.rect.x + frame.rect.w / 2,
    y: frame.rect.y + frame.rect.h / 2,
  };
  const outdoor = redrawOutdoorObjects(art.outdoorObjectViews, centre, strength, frame.rect);
  let interiorRedrawn = 0;
  if (frame.floorId && strength > 0) {
    for (const building of art.buildings) {
      for (const floor of building.floors) {
        if (floor.floor.id === frame.floorId) {
          interiorRedrawn += redrawFloorObjects(floor.objectViews, centre, strength);
        }
      }
    }
  }
  return {
    strength,
    outdoor,
    interiorRedrawn,
    durationMs: performance.now() - started,
  };
}

/** Authoritative object colliders, drawn only when the lab asks for footprint truth. */
function buildFootprintOverlay(
  map: MapDocument,
  floorId: string | undefined,
): Graphics {
  const g = new Graphics();
  const objects = floorId
    ? map.buildings.flatMap((building) => building.floors)
      .find((floor) => floor.id === floorId)?.objects ?? []
    : map.outdoor.objects;
  for (const object of objects) {
    for (const solid of objectSolids(object)) {
      if (solid.kind === "rect") {
        g.rect(solid.x, solid.y, solid.w, solid.h)
          .fill({ color: 0x00a7b5, alpha: 0.12 })
          .stroke({ color: 0x006973, alpha: 0.9, width: 1.5 });
      } else if (solid.kind === "capsule") {
        g.moveTo(solid.ax, solid.ay).lineTo(solid.bx, solid.by)
          .stroke({ color: 0x00a7b5, alpha: 0.16, width: solid.r * 2 });
        g.moveTo(solid.ax, solid.ay).lineTo(solid.bx, solid.by)
          .stroke({ color: 0x006973, alpha: 0.9, width: 1.5 });
        g.circle(solid.ax, solid.ay, solid.r).stroke({ color: 0x006973, alpha: 0.9, width: 1.5 });
        g.circle(solid.bx, solid.by, solid.r).stroke({ color: 0x006973, alpha: 0.9, width: 1.5 });
      } else {
        g.poly(solid.points)
          .fill({ color: 0x00a7b5, alpha: 0.12 })
          .stroke({ color: 0x006973, alpha: 0.9, width: 1.5 });
      }
    }
  }
  return g;
}

/**
 * Walk a DotBot across the crop so the trail it leaves can be looked at.
 *
 * The one piece of ambient motion this surface could not otherwise show. Rides and canopies
 * are a function of the clock, so `?t=` is enough; a trail is a function of where somebody
 * WENT, and with no bots on a still there is nothing to have gone anywhere.
 *
 * It drives the production pool through the production pacing — `trailStep` decides where each
 * mark lands and `fadeTrail` decides how strong it is — so what comes back is what a player
 * sees, not a drawing of what a player might see. The route is sampled finely and stepped
 * exactly as `updateTrails` steps it.
 *
 * The stamps are backdated by the real cadence (a stride at walking speed is 80 ms) so the tail
 * fades along its length instead of the whole trail sharing one age. That gradient is most of
 * what there is to judge: a trail that reads at the head and dies too fast behind it is the
 * defect this frame exists to catch.
 */
function walkTheCrop(art: MapArt, map: MapDocument, rect: Rect, clockMs: number): number {
  /**
   * A ROUTE WITH A HAIRPIN IN IT, and that is the point of it.
   *
   * The first version was a gentle sine wave, which is the one shape that cannot show the defect
   * this frame exists to catch. Suggested while reviewing it: "you should add a more harsh turn
   * in it so you can see the lines I'm talking about too" — and right, because every artefact
   * reported about a trail so far has been about the JOINS between marks, and a wave barely
   * bends them. A hairpin puts two consecutive marks nearly 90° apart.
   *
   * Waypoints in fractions of the crop, so the same route works on any frame: a slow bend, a
   * hard V, then a long easy run out. Walked as a polyline, so the corners are genuinely sharp
   * rather than smoothed by the sampler.
   */
  const waypoints: Vec2[] = [
    { x: 0.08, y: 0.66 }, { x: 0.28, y: 0.80 }, { x: 0.40, y: 0.62 },
    { x: 0.46, y: 0.94 }, { x: 0.68, y: 0.74 }, { x: 0.94, y: 0.82 },
  ];
  const route = (t: number): Vec2 => {
    const span = (waypoints.length - 1) * Math.min(0.999999, Math.max(0, t));
    const leg = Math.floor(span);
    const into = span - leg;
    const from = waypoints[leg];
    const to = waypoints[leg + 1];
    return {
      x: rect.x + rect.w * (from.x + (to.x - from.x) * into),
      y: rect.y + rect.h * (from.y + (to.y - from.y) * into),
    };
  };

  const laid: Array<{ from: Vec2; at: Vec2; heading: number }> = [];
  let anchor: Vec2 | undefined;
  const samples = 600;
  for (let i = 0; i <= samples; i += 1) {
    const at = route(i / samples);
    const step = trailStep(anchor, at);
    anchor = step.anchor;
    // The same gate the renderer applies, so a crop over paving correctly shows nothing.
    if (step.crossed && isSoftGround(groundAt(map, at))) {
      laid.push({ from: step.from, at, heading: step.heading });
    }
  }

  const cadenceMs = 80;
  for (let i = 0; i < laid.length; i += 1) {
    const age = (laid.length - 1 - i) * cadenceMs;
    stampTrail(art.trails, laid[i].from, laid[i].at, laid[i].heading, clockMs - age);
  }
  fadeTrail(art.trails, clockMs);
  return laid.length;
}

export function WorldLab() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const params = new URLSearchParams(window.location.search);
    const pick = params.get("pick");
    const shots = params.get("shots") === "1";
    /** `&walk=1` lays a DotBot's trail across the crop. See `walkTheCrop`. */
    const walk = params.get("walk") === "1";
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
      /** Region crops first, then every interior floor. `?worlds&pick=` reaches both. */
      const allFrames = [...FRAMES, ...floorFrames(map)];

      /**
       * THE CLOCK, so ambient motion can be reviewed at all.
       *
       * `?t=<ms>` puts the world's moving parts where they would be that many milliseconds
       * into a match, then renders one still. Without it this surface can only ever see the
       * resting pose, which is the one pose that proves nothing: a ride that does not turn
       * and a ride whose canopy is parked both look identical at t=0.
       *
       * Two shots at different `t` values is the whole verification — the same crop, the
       * same geometry, one number changed. Default 0 keeps the ambient pose at rest; object
       * parallax has its own explicit `parallax=` stamp and control.
       *
       * NOT `at`. That name is taken, by `selectMapDocument` → `spawnAt`, where it names an
       * arrival point to start the player at — so `?at=30000` would have quietly asked for
       * an insertion point called "30000" as well as setting the clock.
       */
      const clockMs = Math.max(0, Number(params.get("t") ?? 0)) || 0;
      const parallaxStrength = parseObjectParallaxStrength(window.location.search);
      animateAmbient(art.movers, clockMs, false);

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
      /**
       * `art.foreground` TOO, and it was missing.
       *
       * The renderer parents it separately — `worldLayer.addChild(..., dynamicGfx,
       * art.foreground)` — because it is the one layer that draws after the bots. This surface
       * staged only `art.root`, which was invisible for as long as the foreground was empty and
       * became a hole in the world the moment tree canopies moved onto it: the shot came back
       * with three cast shadows and no trees above them.
       *
       * Added in the renderer's own order, so a still is the same stack a frame of play is.
       *
       * `overhead`, NOT `foreground`: the latter is assigned as the fog mask and pixi consumes
       * a mask rather than drawing it, so canopies parented there are invisible on screen. That
       * cost a round — the lab showed them because a mask nobody had assigned yet still draws,
       * and `?solo` showed three grey shadows and no trees.
       */
      stage.addChild(art.root, art.overhead);
      let footprintOverlay = params.get("footprints") === "1"
        ? buildFootprintOverlay(map, undefined)
        : null;
      if (footprintOverlay) stage.addChild(footprintOverlay);
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
          /**
           * A building's OWN roof plan keeps its mass, because that mass is the plan.
           *
           * `roofMasses` is documented as "everything above ground level, which is everything
           * that parallaxes" — for an authored ROOF plan that means the deck, the membrane, the
           * bulkheads and every piece of equipment on it. Stripping it to see the floor
           * underneath is right for the seven storeys below and exactly wrong for the roof
           * itself: what is left behind in `view` is the cast shadow and the wall plate, so all
           * three roof plans in the world rendered as a solid near-black rectangle. The
           * membrane is 0xbcc0c4 and the shot sampled 20,23,26, which is the shadow.
           *
           * So the ROOF frames were unreviewable, silently, in the surface built for reviewing
           * floors. `roofFloorId` already exists to answer this exact question.
           */
          const showingItsOwnRoof = floorId !== null && building.roofFloorId === floorId;
          for (const mass of building.roofMasses) mass.visible = floorId === null || showingItsOwnRoof;
          building.roof.visible = floorId === null;
          for (const floor of building.floors) {
            floor.view.visible = floorId === null ? floor.floor.label === "GROUND" : floor.floor.id === floorId;
          }
        }
        if (footprintOverlay) {
          footprintOverlay.removeFromParent();
          footprintOverlay.destroy();
          footprintOverlay = buildFootprintOverlay(map, floorId ?? undefined);
          stage.addChild(footprintOverlay);
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
        /**
         * `&pick=` narrows the sheet to one frame.
         *
         * The whole sheet is 43 renders, and a review that wants ONE frame at two clock
         * values had no way to ask for it — which pushed motion review onto browser-pane
         * screenshots, at half the canvas resolution and cropped by the pane. A named frame
         * writes a full-resolution PNG that can be opened and compared properly.
         */
        const wanted = pick ? allFrames.filter((frame) => frame.id === pick) : allFrames;
        const parallaxStats: LabParallaxStats[] = [];
        for (const shot of wanted) {
          showFloor(shot.floorId ?? null);
          parallaxStats.push(applyFrameParallax(art, shot, parallaxStrength));
          // The frame's own rect stands in for the camera's visible bounds: a still has no
          // camera, and leaves that spawned off the whole sheet would put none in the crop.
          driftLeaves(art.leaves, art.movers, clockMs, shot.rect, false);
          if (walk) walkTheCrop(art, map, shot.rect, clockMs);
          const long = Math.max(shot.rect.w, shot.rect.h);
          const scale = Math.min(1, 2200 / long);
          const width = Math.round(shot.rect.w * scale);
          const height = Math.round(shot.rect.h * scale);
          created.renderer.resize(width, height);
          frame(shot.rect, width, height);
          created.render();
          const png = created.canvas.toDataURL("image/png");
          const parallaxStamp = params.has("parallax")
            ? `-p${String(parallaxStrength).replace(".", "-")}`
            : "";
          const response = await fetch("/__lab/shot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            // Stamped with the clock when the clock is set, so a motion review writes its
            // own files instead of overwriting the review sheet with one moment of it.
            body: JSON.stringify({
              name: `map-${shot.id}${clockMs ? `-t${clockMs}` : ""}${parallaxStamp}`,
              png,
            }),
          });
          const body = await response.json() as { ok?: boolean; error?: string };
          results.push(`${shot.id}: ${body.ok ? "ok" : `FAILED ${body.error ?? ""}`}`);
        }
        (window as unknown as { worldShots?: string[] }).worldShots = results;
        (window as unknown as { worldParallaxStats?: LabParallaxStats[] }).worldParallaxStats = parallaxStats;
        host.dataset.parallaxStats = JSON.stringify(parallaxStats);
        return;
      }

      const chosen = allFrames.find((candidate) => candidate.id === pick) ?? allFrames[0];
      showFloor(chosen.floorId ?? null);
      const parallaxStats = applyFrameParallax(art, chosen, parallaxStrength);
      (window as unknown as { worldParallaxStats?: LabParallaxStats }).worldParallaxStats = parallaxStats;
      host.dataset.parallaxStats = JSON.stringify(parallaxStats);
      driftLeaves(art.leaves, art.movers, clockMs, chosen.rect, false);
      if (walk) walkTheCrop(art, map, chosen.rect, clockMs);
      const draw = (): void => {
        created.renderer.resize(host.clientWidth, host.clientHeight);
        frame(chosen.rect, created.renderer.width, created.renderer.height);
        created.render();
      };
      draw();

      /**
       * `?play=1` — the world running, with nothing else running.
       *
       * The only surface in the project where ambient motion can actually be WATCHED. The
       * production loop cannot be driven from a review tool: it wants a socket, a snapshot
       * stream and real input. This wants none of them, because ambient motion is a pure
       * function of the clock — so a bare `requestAnimationFrame` calling the same
       * `animateAmbient` the renderer calls is not a simulation of the effect, it IS the
       * effect, on the same code path.
       *
       * Off by default. A still frame has to stay a still frame or two screenshots of the
       * same crop stop being comparable, which is this surface's whole job.
       */
      let frameHandle = 0;
      if (params.get("play") === "1") {
        const started = performance.now();
        const step = (): void => {
          const at = clockMs + performance.now() - started;
          animateAmbient(art.movers, at, false);
          driftLeaves(art.leaves, art.movers, at, chosen.rect, false);
          // Re-laid every frame rather than aged out. Honest about what it is: a trail is
          // history, and there is nobody walking here, so keeping one alive means restamping
          // it. What this shows is the mark and the fade gradient, not a bot's route.
          if (walk) walkTheCrop(art, map, chosen.rect, at);
          created.render();
          frameHandle = requestAnimationFrame(step);
        };
        frameHandle = requestAnimationFrame(step);
      }

      const observer = new ResizeObserver(draw);
      observer.observe(host);
      const held = created as unknown as { __observer?: ResizeObserver; __frame?: number };
      held.__observer = observer;
      held.__frame = frameHandle;
      void Graphics;
    })();

    return () => {
      disposed = true;
      const held = app as unknown as { __observer?: ResizeObserver; __frame?: number } | null;
      held?.__observer?.disconnect();
      if (held?.__frame) cancelAnimationFrame(held.__frame);
      app?.destroy(true, { children: true });
    };
  }, []);

  const strength = parseObjectParallaxStrength(window.location.search);
  const footprints = new URLSearchParams(window.location.search).get("footprints") === "1";
  const hrefAt = (value: number): string => {
    const params = new URLSearchParams(window.location.search);
    params.set("parallax", String(value));
    return `?${params.toString()}`;
  };
  return (
    <>
      <div ref={hostRef} style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#6e7378" }} />
      <nav
        aria-label="Object parallax strength"
        style={{
          position: "fixed", left: 12, top: 12, display: "flex", gap: 5, padding: 6,
          borderRadius: 5, background: "rgba(20,23,26,0.86)", font: "11px system-ui",
        }}
      >
        <span style={{ color: "#f4f5f6", padding: "3px 5px" }}>Parallax</span>
        {[0, 0.25, 0.5, 1, 2].map((value) => (
          <a
            key={value}
            href={hrefAt(value)}
            aria-current={strength === value ? "true" : undefined}
            style={{
              color: strength === value ? "#17191c" : "#f4f5f6",
              background: strength === value ? "#f4f5f6" : "#474d52",
              borderRadius: 3,
              padding: "3px 7px",
              textDecoration: "none",
            }}
          >
            {value}
          </a>
        ))}
        <a
          href={(() => {
            const params = new URLSearchParams(window.location.search);
            if (footprints) params.delete("footprints");
            else params.set("footprints", "1");
            return `?${params.toString()}`;
          })()}
          aria-current={footprints ? "true" : undefined}
          style={{
            color: footprints ? "#17191c" : "#f4f5f6",
            background: footprints ? "#8fdbe0" : "#474d52",
            borderRadius: 3,
            padding: "3px 7px",
            textDecoration: "none",
          }}
        >
          footprints
        </a>
      </nav>
    </>
  );
}
