import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { downtownMap } from "@dotbot/game/content/downtown";
import { solidBounds } from "@dotbot/game/geometry";
import type { Barrier, Rect } from "@dotbot/game/types";
import { SHADOW_ALPHA, type ShadowPad } from "./tone";
import { drawBarrier, INTERIOR_WALLS, ROOF_BULKHEAD, WALL_MAT } from "./modelWalls";

/**
 * A wall that collides has to be a wall you can see.
 *
 * Play found the gap from a roof deck: "there's a room over to the left. You can see
 * the shadows, but I don't actually see the walls that are creating the shadows", and
 * the stair behind them "just a slightly see-through grey box". Both symptoms were one
 * cause — `buildRoofModel` drew the authored ROOF plan's objects and not its walls, so
 * the machine-room bulkhead and the NE shaft were colliders and sight-blockers that put
 * nothing on screen. The grey was the line-of-sight wash those invisible walls cast.
 *
 * WHAT THIS PINS. That the drawing path produces marks for the real authored roof
 * walls, that the marks stay inside the collider, and that a roof bulkhead is not drawn
 * in interior wall tone. It does NOT pin the WIRING — the line in `buildRoofModel` that
 * calls this. `modelRoof` constructs pixi Containers, so importing it needs a DOM this
 * suite does not have; deleting the call would not fail anything here.
 */

type Painted = { color: number; points: Rect[] };

/** Enough of Pixi's Graphics to record filled geometry. Same shape as modelStairs.test. */
class Recorder {
  readonly painted: Painted[] = [];
  private pending: Rect[] = [];
  private path: Array<{ x: number; y: number }> = [];

  rect(x: number, y: number, w: number, h: number): this {
    this.pending.push({ x, y, w, h });
    return this;
  }

  roundRect(x: number, y: number, w: number, h: number): this {
    return this.rect(x, y, w, h);
  }

  poly(points: number[] | Array<{ x: number; y: number }>): this {
    const flat = typeof points[0] === "number"
      ? (points as number[])
      : (points as Array<{ x: number; y: number }>).flatMap((point) => [point.x, point.y]);
    this.bounds(flat);
    return this;
  }

  moveTo(x: number, y: number): this {
    this.path = [{ x, y }];
    return this;
  }

  lineTo(x: number, y: number): this {
    this.path.push({ x, y });
    return this;
  }

  circle(cx: number, cy: number, radius: number): this {
    return this.rect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  arc(cx: number, cy: number, radius: number): this {
    return this.circle(cx, cy, radius);
  }

  closePath(): this {
    return this;
  }

  beginPath(): this {
    return this;
  }

  stroke(style?: { color?: number }): this {
    return this.paint(style?.color ?? 0);
  }

  fill(style?: { color?: number } | number): this {
    const color = typeof style === "number" ? style : style?.color ?? 0;
    return this.paint(color);
  }

  private bounds(flat: number[]): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index + 1 < flat.length; index += 2) {
      minX = Math.min(minX, flat[index]);
      maxX = Math.max(maxX, flat[index]);
      minY = Math.min(minY, flat[index + 1]);
      maxY = Math.max(maxY, flat[index + 1]);
    }
    if (minX <= maxX) this.pending.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }

  private paint(color: number): this {
    if (this.path.length > 1) this.bounds(this.path.flatMap((point) => [point.x, point.y]));
    if (this.pending.length > 0) this.painted.push({ color, points: this.pending });
    this.pending = [];
    this.path = [];
    return this;
  }
}

const recorder = () => new Recorder() as unknown as Graphics & { painted: Painted[] };
const pad = (): ShadowPad => SHADOW_ALPHA.map(() => recorder());

/** Every barrier on an authored ROOF plan, which is what had no drawing path. */
function roofBarriers(): Array<{ buildingId: string; barrier: Barrier }> {
  const found: Array<{ buildingId: string; barrier: Barrier }> = [];
  for (const building of downtownMap.buildings) {
    const roof = building.floors.find((floor) => floor.label === "ROOF");
    for (const barrier of roof?.barriers ?? []) {
      // The shell is the parapet's own geometry; the roof draws that separately.
      if (barrier.id === "ROOF-shell") continue;
      found.push({ buildingId: building.id, barrier });
    }
  }
  return found;
}

/** The union of a barrier's collider, which is the shape the drawing must not leave. */
function colliderBounds(barrier: Barrier): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const solid of barrier.solids) {
    const box = solidBounds(solid);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

describe("a roof's own walls", () => {
  it("has some to draw, so the fixture cannot quietly become vacuous", () => {
    // If the compiler ever stops emitting roof barriers, every assertion below
    // passes over an empty list and says nothing. Two towers carry them today.
    const barriers = roofBarriers();
    expect(barriers.map((entry) => entry.barrier.id).sort())
      .toEqual(["beacon-core-east", "civic-core-b", "civic-machine-room"]);
  });

  it("draws every one of them", () => {
    for (const { buildingId, barrier } of roofBarriers()) {
      const g = recorder();
      drawBarrier(g, pad(), barrier, ROOF_BULKHEAD);
      expect(
        g.painted.length,
        `${buildingId}/${barrier.id} drew nothing, so it is a collider you cannot see`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the drawn wall inside the wall that stops you", () => {
    /**
     * The contract's rule, and the reason this bug was a bug: silhouette == footprint
     * == collider. `volume` lifts the cap, so the mark may rise; the check is that it
     * never spreads sideways beyond the collider it is standing in for.
     */
    for (const { buildingId, barrier } of roofBarriers()) {
      const g = recorder();
      drawBarrier(g, pad(), barrier, ROOF_BULKHEAD);
      const box = colliderBounds(barrier);
      for (const mark of g.painted) {
        for (const part of mark.points) {
          expect(part.x, `${buildingId}/${barrier.id} spills west`).toBeGreaterThanOrEqual(box.x - 0.01);
          expect(part.x + part.w, `${buildingId}/${barrier.id} spills east`)
            .toBeLessThanOrEqual(box.x + box.w + 0.01);
        }
      }
    }
  });

  it("is lighter than an interior wall, because it stands in daylight", () => {
    /**
     * Not a style preference. A housing drawn in interior wall tone is nearly black
     * against the roof membrane and reads as a hole punched in the deck — the exact
     * failure `drawStairHead` was written to fix, and a bulkhead beside that housing
     * has to be the same material or the roof grows two languages for one thing.
     */
    expect(ROOF_BULKHEAD.shell.top).toBeGreaterThan(WALL_MAT.top);
    expect(INTERIOR_WALLS.shell.top).toBe(WALL_MAT.top);
    const membrane = 0xbcc0c4;
    expect(ROOF_BULKHEAD.shell.top, "a bulkhead must not vanish into the membrane either")
      .toBeGreaterThan(membrane);
  });
});
