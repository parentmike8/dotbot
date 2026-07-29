import { describe, expect, it } from "vitest";
import { worldMap } from "./content/world";
import { isInWater, waterBodies } from "./water";
import { collectSolids } from "./collision";
import { pointToSolidDistanceSquared } from "./geometry";

describe("open water", () => {
  it("finds every body the world authors, whichever way it was authored", () => {
    const bodies = waterBodies(worldMap);
    expect(bodies.length).toBeGreaterThan(0);
    // The cenote is the world's one pool today; a rect `Surface` would be found too.
    expect(bodies.map((body) => body.id)).toContain("tmp-cenote");
    for (const body of bodies) expect(body.points.length).toBeGreaterThanOrEqual(3);
  });

  it("knows the middle of a pool from the ground beside it", () => {
    const cenote = waterBodies(worldMap).find((body) => body.id === "tmp-cenote")!;
    const centre = cenote.points.reduce(
      (sum, point) => ({ x: sum.x + point.x / cenote.points.length, y: sum.y + point.y / cenote.points.length }),
      { x: 0, y: 0 },
    );
    expect(isInWater(worldMap, centre)).toBe(true);
    // The plaza, four hundred units away and definitely dry.
    expect(isInWater(worldMap, { x: 3310, y: 2700 })).toBe(false);
  });

  /**
   * THE POINT OF THE KIND, asserted rather than described.
   *
   * `SurfaceKind`'s note on `water` is emphatic: it draws water and blocks NOTHING, because
   * water a bot cannot cross needs something visible doing the stopping — a bank, a kerb, a
   * cenote rim — and invisible collision over a pool is the same lie as a ghost fixture told
   * the other way round. Now that wading has a visual treatment, that promise is load-bearing
   * in a second way: the treatment is the only thing telling the player they are in it.
   */
  it("is wadeable — nothing solid stands in the water itself", () => {
    const solids = collectSolids(worldMap, "outdoor");
    const blocked: string[] = [];
    for (const body of waterBodies(worldMap)) {
      const xs = body.points.map((point) => point.x);
      const ys = body.points.map((point) => point.y);
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 20) {
        for (let y = Math.min(...ys); y <= Math.max(...ys); y += 20) {
          const at = { x, y };
          // Only the water's own middle: a rim is SUPPOSED to be solid, and it stands at
          // the edge, so sample where a bot would actually be swimming.
          if (!isInWater(worldMap, at)) continue;
          if (!isInWater(worldMap, { x: x - 34, y }) || !isInWater(worldMap, { x: x + 34, y })) continue;
          if (!isInWater(worldMap, { x, y: y - 34 }) || !isInWater(worldMap, { x, y: y + 34 })) continue;
          if (solids.some((solid) => pointToSolidDistanceSquared(at, solid) <= 0)) {
            blocked.push(`${body.id}: something solid stands at (${x}, ${y})`);
          }
        }
      }
    }
    expect(blocked).toEqual([]);
  });
});
