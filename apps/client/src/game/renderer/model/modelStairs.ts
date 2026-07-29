import type { Graphics } from "pixi.js";
import type { Rect, StairLink } from "@dotbot/game/types";
import { stairGuardRects, stairHalves } from "@dotbot/game/mapModel";
import { LIFT, MAT, V, contact, inlay, shade, volume, type ShadowPad } from "./tone";

/**
 * Stairs, in the lit-model language.
 *
 * Split out of `modelFloor` for one reason: everything here takes a `Graphics` and
 * draws into it, and nothing here constructs one. That makes the file pixi-runtime
 * free, so a test can hand it a recorder and measure the geometry — which is how the
 * roof stair's two views are held apart. `modelFloor` itself builds containers, so
 * importing it pulls pixi's runtime in and wants a DOM.
 */

/**
 * A descending flight. Treads darken as they drop, which is the whole reason
 * the language works for a vertical world: depth is a value change, not a
 * change of projection, so a stair down looks like a stair down from directly
 * above and never needs a camera trick.
 */
type TreadRun = { half: Rect; from: number; to: number };

/** The lightest and darkest a tread is drawn. Depth darkens it; see `drawTreadRun`. */
const TOP_DEPTH = 0.02;
const FOOT_DEPTH = 0.98;

/**
 * The two runs of a flight, in draw order, with their depth ramps.
 *
 * `beyond` is the run past the break line — the half a bot crossing the stair
 * disappears into. That is the *exit* half whichever way the flight goes, which is
 * not the same as "the last one drawn": on a descending flight the exit run is
 * drawn second, and on an ascending one it is drawn first.
 *
 * DEPTH COMES FROM POSITION ALONG THE FLIGHT, not from which half a tread is in, and
 * that is a fix rather than a preference. The ramp used to be handed to each half as a
 * literal pair — entry 0.02→0.55, exit 0.55→0.98 — which is continuous only if the entry
 * half happens to sit at the low coordinate. It does when `bottom` is "S" or "E", which
 * is every stair in the city, and it does NOT when `bottom` is "N" or "W". Those flights
 * came out running 0.55→0.98 and then jumping back to 0.02, so a bright tread sat against
 * a black one exactly at the midline. Reported from play: "there's a weird sort of hard
 * line in the stair, it doesn't gradually transition from light to dark... something is
 * off relative to the stairs in other places."
 *
 * THE RAMP RUNS ENTRY → EXIT, NOT TOP → FOOT, and that is the second fix here.
 *
 * It used to follow `bottom`, the flight's physical foot: light at the head of the run,
 * dark at its foot. Physically tidy, and it inverted the one cue a player actually steers
 * by. `stairEntryEnd` is what `placeStairTag` uses, so the "UP"/"DN" label already marks
 * the way in — and with `bottom: "S"`, which is every stair in the city, the arithmetic
 * lands like this:
 *
 *     direction "up"    entry at high y    light at low y    -> ENTERED AT THE DARK END
 *     direction "down"  entry at low y     light at low y    -> entered at the light end
 *
 * So every ascending flight in the world was entered at its dark end, every descending one
 * at its light end, and two stairs on one floor read opposite ways. Reported from play:
 * "it's still not obvious which end I go into. A couple times, I went in the wrong direction
 * because it wasn't clear."
 *
 * The rule now is the one a player had already inferred: THE END YOU WALK IN AT IS THE
 * COLOUR OF THE FLOOR YOU ARE STANDING ON, and it darkens away from you toward the half you
 * cannot enter. `stairHalves` derives entry per floor, so the same physical flight draws
 * light-at-the-bottom on one floor and light-at-the-top on the other, with no authoring.
 *
 * Note what this does NOT do. Mike offered "or it transitions towards the colour of the
 * floor that I'm going to", which would be better if floors differed in tone — they do not.
 * Every slab in the game is `V.slab`, so a ramp toward the destination's colour would be a
 * ramp to the same value and would say nothing. Darkening away from the floor you are on is
 * the honest version of the same idea, and it also keeps up and down consistent, which is
 * the actual complaint.
 */
function treadRuns(stair: StairLink): { runs: TreadRun[]; beyond: TreadRun; vertical: boolean } {
  const { entry, exit, vertical } = stairHalves(stair);
  const { x, y, w, h } = stair.rect;
  const span = vertical ? h : w;
  const low = vertical ? y : x;
  /**
   * The entry half at the low coordinate means depth grows as the coordinate GROWS.
   *
   * Read off the halves rather than off `bottom`, so this cannot drift from `stairHalves` —
   * which is the same function `resolveStairs` uses to decide whether a bot actually changed
   * floor. Art and traversal now answer "which end is the way in" from one place.
   */
  const entryAtLow = (vertical ? entry.y : entry.x) < (vertical ? exit.y : exit.x);

  const depth = (along: number): number => {
    const t = (along - low) / span;
    return TOP_DEPTH + (entryAtLow ? t : 1 - t) * (FOOT_DEPTH - TOP_DEPTH);
  };
  /** `drawTreadRun` always lays treads in increasing coordinate order. */
  const ramp = (half: Rect): TreadRun => ({
    half,
    from: depth(vertical ? half.y : half.x),
    to: depth(vertical ? half.y + half.h : half.x + half.w),
  });

  const exitRun = ramp(exit);
  const entryRun = ramp(entry);
  return {
    runs: stair.direction === "down" ? [entryRun, exitRun] : [exitRun, entryRun],
    beyond: exitRun,
    vertical,
  };
}

export function drawTreadRun(g: Graphics, run: TreadRun, vertical: boolean): void {
  const span = vertical ? run.half.h : run.half.w;
  const treads = Math.max(4, Math.round(span / 16));
  for (let i = 0; i < treads; i += 1) {
    const depth = run.from + (run.to - run.from) * (i / treads);
    const tread: Rect = vertical
      ? { x: run.half.x, y: run.half.y + (span / treads) * i, w: run.half.w, h: span / treads }
      : { x: run.half.x + (span / treads) * i, y: run.half.y, w: span / treads, h: run.half.h };
    /**
     * The tread's own value, ramped off THE FLOOR'S TONE rather than off steel.
     *
     * `V.slab` at the entry end, so the first tread is the value of the slab a bot is
     * standing on and the flight reads as the floor continuing. It used to start from
     * `MAT.steel.top`, which is built from 0xbabfc4 against a 0xdcdee1 slab — visibly
     * darker than the floor at its lightest point, so even the light end never looked like
     * somewhere you were already standing.
     *
     * Nose and riser stay as separate strokes so a tread is still a tread, but both are
     * derived from the same ramp: the nose brightens toward white so it survives at the
     * light end, the riser is a fraction of the tread so it deepens with it.
     */
    const k = 1 - depth * 0.74;
    inlay(g, tread, shade(V.slab, k));
    inlay(
      g,
      vertical
        ? { x: tread.x, y: tread.y + tread.h - 1.6, w: tread.w, h: 1.6 }
        : { x: tread.x + tread.w - 1.6, y: tread.y, w: 1.6, h: tread.h },
      shade(V.slab, k * 0.66),
    );
    inlay(
      g,
      vertical ? { x: tread.x, y: tread.y, w: tread.w, h: 0.8 } : { x: tread.x, y: tread.y, w: 0.8, h: tread.h },
      shade(0xffffff, k),
    );
  }
}

export function drawStair(g: Graphics, pad: ShadowPad, stair: StairLink): void {
  const r = stair.rect;

  // The shaft opening: a hole in the slab, dark at the bottom.
  contact(pad, r, LIFT.wall);
  inlay(g, r, 0x23272b);

  const { runs, vertical } = treadRuns(stair);
  for (const run of runs) drawTreadRun(g, run, vertical);

  // Stringers down both flanks.
  for (const end of [0, 1]) {
    const side: Rect = vertical
      ? { x: r.x + (end ? r.w - 3 : 0), y: r.y, w: 3, h: r.h }
      : { x: r.x, y: r.y + (end ? r.h - 3 : 0), w: r.w, h: 3 };
    volume(g, side, MAT.steelDeep, 5);
  }

  /**
   * The mouth, and the rails. Two cues for the same fact, both derived rather than styled.
   *
   * Reported from play: "the edge that is not passable is not clear enough at all." Value
   * alone was carrying the whole message, and value alone is a comparison — it needs the
   * other end of the flight in frame to be read at all, which at play zoom it often is not.
   *
   * THE MOUTH is a bright threshold across the entry half's outer end: the lip a bot steps
   * over. Truthful for every stair, because `stairHalves` says which half is the entry on
   * this floor, and it marks the one end that is always open.
   *
   * THE RAILS come from `stairGuardRects`, which is the collider the server, the predictor
   * and navigation all use. So drawing them adds no new claim — it draws a barrier that was
   * already there and previously invisible. They exist only on `access: "openEnd"` flights;
   * elsewhere authored walls already enclose the shaft and are already drawn.
   */
  const { entry, exit, vertical: runsVertical } = stairHalves(stair);
  const mouthDepth = 2.6;
  const mouth: Rect = runsVertical
    ? {
      x: entry.x,
      w: entry.w,
      y: entry.y < exit.y ? entry.y : entry.y + entry.h - mouthDepth,
      h: mouthDepth,
    }
    : {
      y: entry.y,
      h: entry.h,
      x: entry.x < exit.x ? entry.x : entry.x + entry.w - mouthDepth,
      w: mouthDepth,
    };
  inlay(g, mouth, 0xffffff);

  for (const guard of stairGuardRects(stair)) volume(g, guard, MAT.steelDeep, LIFT.wall);
}


/**
 * The same stair, seen from the roof above it.
 *
 * From up here you cannot see the flight — it is inside a housing, and what shows
 * is a small box with a door in one side. Drawing the open treads on a roof is
 * what put "stairs visible through the roof" on this map: the flight was right
 * for every floor below and simply wrong for the one on top, because a roof is
 * the only floor that looks *down* onto a stair from outside it.
 */
export function drawStairHead(g: Graphics, pad: ShadowPad, stair: StairLink): void {
  const r = stair.rect;
  const { entry, vertical } = stairHalves(stair);

  contact(pad, r, LIFT.column);
  /**
   * Built of the same stuff as the parapet, not of interior wall.
   *
   * A housing drawn in `V.wallCap` is nearly black against the roof membrane, so
   * it reads as a hole punched in the deck — the very thing this replaced. It is
   * a small structure standing *on* a roof in full daylight, so it is the
   * lightest thing up there.
   */
  const top = volume(g, r, MAT.steelLit, LIFT.column);
  inlay(g, { x: top.x + 2.6, y: top.y + 2.6, w: top.w - 5.2, h: top.h - 5.2 }, shade(MAT.steelLit.top, 0.95));

  // The door, on whichever face the flight is entered from.
  const span = (vertical ? r.w : r.h) * 0.46;
  const thick = 5;
  const atLowSide = vertical ? entry.y <= r.y + 0.5 : entry.x <= r.x + 0.5;
  inlay(g, vertical
    ? { x: r.x + (r.w - span) / 2, y: atLowSide ? r.y : r.y + r.h - thick, w: span, h: thick }
    : { x: atLowSide ? r.x : r.x + r.w - thick, y: r.y + (r.h - span) / 2, w: thick, h: span },
    shade(MAT.steelLit.top, 0.38));
}

