import type { Graphics } from "pixi.js";
import type { Rect, StairLink } from "@dotbot/game/types";
import { stairHalves } from "@dotbot/game/mapModel";
import { LIFT, MAT, contact, inlay, shade, volume, type ShadowPad } from "./tone";

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

/**
 * The two runs of a flight, in draw order, with their depth ramps.
 *
 * `beyond` is the run past the break line — the half a bot crossing the stair
 * disappears into. That is the *exit* half whichever way the flight goes, which is
 * not the same as "the last one drawn": on a descending flight the exit run is
 * drawn second, and on an ascending one it is drawn first.
 */
function treadRuns(stair: StairLink): { runs: TreadRun[]; beyond: TreadRun; vertical: boolean } {
  const { entry, exit, vertical } = stairHalves(stair);
  const down = stair.direction === "down";
  const exitRun: TreadRun = down
    ? { half: exit, from: 0.55, to: 0.98 }
    : { half: exit, from: 0.98, to: 0.55 };
  const entryRun: TreadRun = down
    ? { half: entry, from: 0.02, to: 0.55 }
    : { half: entry, from: 0.55, to: 0.02 };
  return {
    runs: down ? [entryRun, exitRun] : [exitRun, entryRun],
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
    // Tread nose lit, riser in shadow, both darkening with depth.
    const k = 1 - depth * 0.72;
    inlay(g, tread, shade(MAT.steel.top, k));
    inlay(
      g,
      vertical
        ? { x: tread.x, y: tread.y + tread.h - 1.6, w: tread.w, h: 1.6 }
        : { x: tread.x + tread.w - 1.6, y: tread.y, w: 1.6, h: tread.h },
      shade(MAT.steel.edge, k),
    );
    inlay(
      g,
      vertical ? { x: tread.x, y: tread.y, w: tread.w, h: 0.8 } : { x: tread.x, y: tread.y, w: 0.8, h: tread.h },
      shade(MAT.steel.lit, k),
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

