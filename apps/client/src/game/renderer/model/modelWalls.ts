import type { Graphics } from "pixi.js";
import { isDisc, pathOutline, solidBounds } from "@dotbot/game/geometry";
import type { Barrier, Vec2, WallSegment } from "@dotbot/game/types";
import {
  contact,
  contactShape,
  LIFT,
  MAT,
  shade,
  V,
  volume,
  volumeShape,
  type Material,
  type Rect,
  type ShadowPad,
} from "./tone";

/**
 * Walls, in the lit-model language.
 *
 * Split out of `modelFloor` for the same reason `modelStairs` was: everything here
 * takes a `Graphics` and draws into it, and nothing here constructs one. That keeps
 * the file free of pixi's runtime, so a test can hand it a recorder and measure the
 * geometry — and it lets the roof draw its own walls, which is what it was not doing.
 *
 * A ROOF plan's walls had no drawing path at all. The compiler turns authored path
 * walls into `barriers`, physics and visibility both consume them, and
 * `buildRoofModel` read neither — so Civic's machine-room bulkhead and its NE shaft
 * were colliders and sight-blockers that drew nothing. Play found it from the deck:
 * "there's a room over to the left. You can see the shadows, but I don't actually see
 * the walls that are creating the shadows." The shadows were the line-of-sight wash
 * cast by walls that existed everywhere except on screen.
 */

/**
 * How a run of wall is built: its material and how far it stands off the slab.
 *
 * A partition indoors and a bulkhead on a roof are the same geometry in different
 * light, and the difference is not decoration — a housing drawn in interior wall
 * tone is nearly black against the roof membrane and reads as a hole punched in the
 * deck, which is the exact failure `drawStairHead` was written to fix. So the caller
 * says which it is.
 */
export type WallStyle = { shell: Material; partition: Material; shellLift: number; partitionLift: number };

/** A shell wall: dark cap, dark face, the heavy line of the building. */
export const WALL_MAT: Material = { top: V.wallCap, front: V.wall, edge: 0x0b0e11, lit: 0x4d5359 };
/** A partition: lighter cap, so a room divider is legibly not an outside wall. */
export const PART_MAT: Material = { top: V.partitionCap, front: shade(V.wall, 1.35), edge: 0x14171a, lit: 0x585e64 };

/** Indoors: shell walls heavier than partitions, both in interior wall tone. */
export const INTERIOR_WALLS: WallStyle = {
  shell: WALL_MAT,
  partition: PART_MAT,
  shellLift: 10,
  partitionLift: 7,
};

/**
 * On a roof: one structure standing in full daylight, so it is the lightest thing
 * up there — the same call `drawStairHead` makes for the housing beside it, and for
 * the same reason. A bulkhead and a stair head are the same object to a player.
 */
export const ROOF_BULKHEAD: WallStyle = {
  shell: MAT.steelLit,
  partition: MAT.steelLit,
  shellLift: LIFT.column,
  partitionLift: LIFT.column,
};

/**
 * Group a barrier's capsules back into the contiguous runs they were cut into.
 *
 * A wall stays one named entity in the data — which is what an editor selects and
 * what an author edits — so the renderer recovers the run boundaries by following
 * the chain: consecutive capsules that share an endpoint belong to one stretch, and
 * a break is where a doorway was cut.
 */
export function capsuleRuns(barrier: Barrier): Array<{ points: Vec2[]; thickness: number }> {
  const runs: Array<{ points: Vec2[]; thickness: number }> = [];
  for (const solid of barrier.solids) {
    if (solid.kind !== "capsule" || isDisc(solid)) continue;
    const current = runs.at(-1);
    const tail = current?.points.at(-1);
    const continues = tail
      && Math.abs(tail.x - solid.ax) < 0.01
      && Math.abs(tail.y - solid.ay) < 0.01
      && current!.thickness === solid.r * 2;
    if (continues) current!.points.push({ x: solid.bx, y: solid.by });
    else {
      runs.push({
        points: [{ x: solid.ax, y: solid.ay }, { x: solid.bx, y: solid.by }],
        thickness: solid.r * 2,
      });
    }
  }

  /**
   * Close the loop.
   *
   * Following the chain forwards can never reach the join a closed shell makes at
   * the point its outline was authored from: the two halves of that one corner
   * land in the first and last runs, get mitered independently, and leave a
   * visible step where they fail to meet. Every other corner is interior to the
   * chain and comes out clean, which is why the defect appears at exactly one
   * corner per building — Mercy Clinic's outline starts at `200,140`, so it showed
   * up at the clinic's north-west corner and nowhere else.
   */
  const first = runs[0];
  const last = runs.at(-1);
  if (runs.length > 1 && first && last && first.thickness === last.thickness) {
    const head = first.points[0];
    const tail = last.points.at(-1)!;
    if (Math.abs(head.x - tail.x) < 0.01 && Math.abs(head.y - tail.y) < 0.01) {
      last.points.push(...first.points.slice(1));
      runs.shift();
    }
  }

  return runs;
}

/** A wall at any angle, extruded and shaded by face normal like everything else. */
export function drawBarrier(
  g: Graphics,
  pad: ShadowPad,
  barrier: Barrier,
  style: WallStyle = INTERIOR_WALLS,
): void {
  for (const run of capsuleRuns(barrier)) {
    const outline = pathOutline(run.points, run.thickness);
    if (outline.length < 3) continue;
    const shell = run.thickness >= 11;
    const lift = shell ? style.shellLift : style.partitionLift;
    contactShape(pad, outline, lift);
    volumeShape(g, outline, shell ? style.shell : style.partition, lift);
  }

  /**
   * A pier: the stub of wall left between an opening and the wall's end, too
   * short to have a spine. It is still a piece of wall and still collides, so it
   * draws as one rather than being quietly left off the plan.
   */
  for (const solid of barrier.solids) {
    if (solid.kind !== "capsule" || !isDisc(solid)) continue;
    const shell = solid.r * 2 >= 11;
    const { x, y, w, h } = solidBounds(solid);
    const lift = shell ? style.shellLift : style.partitionLift;
    contact(pad, { x, y, w, h }, lift);
    volume(g, { x, y, w, h }, shell ? style.shell : style.partition, lift);
  }

  // Convex hulls — a ship, a wedge — draw as themselves.
  for (const solid of barrier.solids) {
    if (solid.kind !== "poly") continue;
    contactShape(pad, solid.points, style.shellLift);
    volumeShape(g, solid.points, style.shell, style.shellLift);
  }
}

/** Rect walls, the axis-aligned case the older plans are authored in. */
export function drawWallRects(
  g: Graphics,
  pad: ShadowPad,
  walls: readonly WallSegment[],
  style: WallStyle = INTERIOR_WALLS,
): void {
  for (const wall of walls) {
    const shell = wall.w >= 11 || wall.h >= 11;
    const lift = Math.min(LIFT.wall, Math.max(3, shell ? style.shellLift : style.partitionLift));
    contact(pad, wall as Rect, lift);
    volume(g, wall as Rect, shell ? style.shell : style.partition, lift);
  }
}
