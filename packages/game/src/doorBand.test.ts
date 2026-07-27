import { describe, expect, it } from "vitest";
import type { Doorway, WallSegment } from "./types";
import { bandFromWall } from "./mapModel";

/**
 * A roll-up curtain must sit in the wall's thickness and nowhere else.
 *
 * Regression: the player base's 120-unit archway sat at y474, and the search for
 * its wall only asked whether the door's line fell inside a wall's cross extent.
 * The 616-unit west wall satisfied that, so the archway was drawn as a curtain
 * 120 wide and 616 deep — a shutter running the whole depth of the workshop.
 */
describe("bandFromWall", () => {
  // The base's own geometry: a partition split around a 120 opening, inside a
  // shell whose west wall runs past the opening's line.
  const walls: WallSegment[] = [
    { id: "west", x: 80, y: 72, w: 12, h: 616 },
    { id: "part-w", x: 92, y: 468, w: 108, h: 12 },
    { id: "part-e", x: 320, y: 468, w: 168, h: 12 },
  ];
  const arch: Doorway = { id: "arch", x: 260, y: 474, width: 120, dir: "h" };

  it("takes its depth from the wall the opening was cut from", () => {
    const band = bandFromWall(arch, walls)!;
    expect(band).toEqual({ x: 200, y: 468, w: 120, h: 12 });
  });

  it("never returns a band deeper than the wall it sits in", () => {
    const band = bandFromWall(arch, walls)!;
    const thinnest = Math.min(...walls.filter((w) => w.w >= w.h).map((w) => w.h));
    expect(band.h).toBeLessThanOrEqual(thinnest);
  });

  it("ignores a wall that merely crosses the opening's line", () => {
    // The west wall alone: it crosses y474 but does not run along the opening.
    expect(bandFromWall(arch, [walls[0]])).toBeNull();
  });

  it("prefers a thin partition over a thick shell on the same run", () => {
    const shell: WallSegment = { id: "shell", x: 92, y: 462, w: 400, h: 24 };
    const band = bandFromWall(arch, [shell, ...walls])!;
    expect(band.h).toBe(12);
  });

  it("does the same for a vertical opening", () => {
    const vertical: WallSegment[] = [
      { id: "north", x: 80, y: 60, w: 840, h: 12 },
      { id: "rail", x: 488, y: 500, w: 12, h: 176 },
    ];
    const door: Doorway = { id: "break", x: 494, y: 440, width: 120, dir: "v" };
    expect(bandFromWall(door, vertical)).toEqual({ x: 488, y: 380, w: 12, h: 120 });
  });
});
