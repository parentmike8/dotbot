import { describe, expect, it } from "vitest";
import { CIVIC_SOURCE } from "@dotbot/game/content/civicTower";
import { screenToWorld, snapToGrid, wallNear, WALL_PICK_RANGE } from "./viewport";

/**
 * The seam between a mouse and an edit.
 *
 * Map Studio's edits were covered at both ends and not in the middle: the literal each
 * one emits is pinned by `mapSourcePatch.test.ts`, and the compiled result by the map's
 * own audits. What nothing touched was the pointer path — screen to world, world to
 * grid, and which wall an opening belongs to — because all three were private methods
 * on a class that constructs a pixi `Application`.
 *
 * That gap matters because a fault in it produces a perfectly well-formed edit in the
 * wrong place. A transposed axis, an off-by-one snap, or a door cut into the wall behind
 * the one the author clicked would all pass every existing check.
 */

const box = { left: 100, top: 50, width: 800, height: 600 };

describe("screen to world", () => {
  it("puts the middle of the canvas on the camera centre", () => {
    // The camera is defined by what is in the middle, so this is the identity case: get
    // it wrong and every click is offset by half a screen.
    const middle = screenToWorld(100 + 400, 50 + 300, box, { x: 1000, y: 2000 }, 1);
    expect(middle).toEqual({ x: 1000, y: 2000 });
  });

  it("measures from the box, not the window", () => {
    // `left`/`top` are the canvas's offset in the page. Ignoring them is the classic
    // version of this bug: clicks land correctly only when the canvas is at 0,0.
    const at = screenToWorld(100, 50, box, { x: 0, y: 0 }, 1);
    expect(at).toEqual({ x: -400, y: -300 });
  });

  it("divides by scale, so zooming in makes a pixel worth less", () => {
    const zoomedOut = screenToWorld(100 + 500, 50 + 300, box, { x: 0, y: 0 }, 0.5);
    const zoomedIn = screenToWorld(100 + 500, 50 + 300, box, { x: 0, y: 0 }, 2);
    expect(zoomedOut.x).toBe(200);
    expect(zoomedIn.x).toBe(50);
  });

  it("keeps x with x", () => {
    // A transposed axis survives every symmetric test, so this one is deliberately
    // asymmetric in both the click and the box.
    const at = screenToWorld(100 + 600, 50 + 100, box, { x: 0, y: 0 }, 1);
    expect(at).toEqual({ x: 200, y: -200 });
  });
});

describe("snapping", () => {
  it("rounds to the nearest intersection, not down", () => {
    expect(snapToGrid({ x: 13, y: 21 }, 8)).toEqual({ x: 16, y: 24 });
    expect(snapToGrid({ x: 11, y: 19 }, 8)).toEqual({ x: 8, y: 16 });
  });

  it("passes the point through untouched when snapping is off", () => {
    // `grid: 0` is the author turning it off, and 0 would divide by zero.
    expect(snapToGrid({ x: 13.5, y: -21.25 }, 0)).toEqual({ x: 13.5, y: -21.25 });
  });

  it("snaps negative coordinates the same way", () => {
    expect(snapToGrid({ x: -13, y: -3 }, 8)).toEqual({ x: -16, y: -0 });
  });
});

describe("which wall an opening lands on", () => {
  /**
   * Against real authored source, not a fixture. Civic's GROUND floor has a stair core,
   * a WC block of four walls and a mail room within a few hundred units of each other,
   * which is exactly the situation where picking the nearest wall by endpoint instead of
   * by centreline gets it wrong.
   */
  const ground = "GROUND";

  it("picks the wall under the click and projects onto its centreline", () => {
    // A point just inside the mail room's west face. That wall runs from 2028,404 west
    // to 1884,404 then south to 1884,528 — an L, so an endpoint comparison would prefer
    // whichever corner happened to be closer.
    const hit = wallNear(CIVIC_SOURCE, ground, { x: 1890, y: 470 });
    expect(hit?.wall.id).toBe("civic-mail");
    // Projected onto the centreline at x=1884, not left where the click was.
    expect(hit?.at.x).toBeCloseTo(1884, 6);
    expect(hit?.at.y).toBeCloseTo(470, 6);
  });

  it("prefers the near wall when two are close", () => {
    // Between the stair core's east face (x 1584) and the WC block's west face (x 1704),
    // but nearer the core.
    expect(wallNear(CIVIC_SOURCE, ground, { x: 1596, y: 200 })?.wall.id).toBe("civic-core-a");
    expect(wallNear(CIVIC_SOURCE, ground, { x: 1692, y: 200 })?.wall.id).toBe("civic-wc-split-w");
  });

  it("returns nothing when the click was not meant for a wall", () => {
    /**
     * The reason the range exists: without it every click anywhere on the floor cuts a
     * door into whichever wall is furthest away but still nearest, which is how an
     * opening ends up in a room the author was not looking at.
     */
    expect(wallNear(CIVIC_SOURCE, ground, { x: 1750, y: 460 })).toBeNull();
    // And the boundary is the range itself, measured from a known wall centreline.
    const wall = wallNear(CIVIC_SOURCE, ground, { x: 1884 + WALL_PICK_RANGE - 1, y: 470 });
    expect(wall?.wall.id).toBe("civic-mail");
    expect(wallNear(CIVIC_SOURCE, ground, { x: 1884 + WALL_PICK_RANGE + 1, y: 470 })).toBeNull();
  });

  it("has nothing to offer without a source or on a floor that is not there", () => {
    expect(wallNear(null, ground, { x: 1884, y: 470 })).toBeNull();
    expect(wallNear(CIVIC_SOURCE, "F99", { x: 1884, y: 470 })).toBeNull();
  });
});
