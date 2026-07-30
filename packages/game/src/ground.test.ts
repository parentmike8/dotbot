import { describe, expect, it } from "vitest";
import { worldMap } from "./content/world";
import { groundAt, isSoftGround, type GroundUse } from "./ground";
import type { MapDocument } from "./types";

/**
 * What is underfoot, and whether it keeps a mark.
 *
 * TWO DIFFERENT CLAIMS, tested two different ways, and mixing them is how this kind of
 * module rots. The RESOLUTION ORDER is a rule, so it is pinned on a tiny synthetic map where
 * one overlap can be constructed exactly; the WORLD HAS SOFT GROUND is a fact about content,
 * so it is measured on the real one. A rule tested against content passes for the wrong
 * reason the day the content moves.
 */
describe("ground", () => {
  /**
   * A verge with a road struck through the middle of it, and a footway alongside.
   *
   * That overlap is the whole point: `modelOutdoor` cuts the carriageway in over everything,
   * so a point on both has to answer road. It is authored here rather than found in the world
   * because a rule wants a case built to exercise it.
   */
  const overlapping = (): MapDocument => ({
    width: 600,
    height: 400,
    buildings: [],
    outdoor: {
      roads: [{ id: "main", x: 0, y: 180, w: 600, h: 60 }],
      surfaces: [
        { id: "verge", kind: "verge", x: 0, y: 100, w: 600, h: 220 },
        { id: "walk", kind: "footway", x: 0, y: 20, w: 600, h: 60 },
      ],
      regions: [
        {
          id: "scrub",
          kind: "undergrowth",
          points: [{ x: 400, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 160 }, { x: 400, y: 160 }],
        },
      ],
      walls: [],
      objects: [],
    },
    stairs: [],
    dots: [],
    extractionPoints: [],
    insertionPoints: [],
  } as unknown as MapDocument);

  it("resolves in drawing order: road, then region, then surface, then bare site", () => {
    const map = overlapping();
    // On the carriageway AND inside the verge. The road is cut in last, so the road wins.
    expect(groundAt(map, { x: 200, y: 210 })).toBe("road");
    // Inside the region AND the verge under it. Regions are drawn after surfaces.
    expect(groundAt(map, { x: 500, y: 130 })).toBe("undergrowth");
    // The verge alone.
    expect(groundAt(map, { x: 200, y: 130 })).toBe("verge");
    // Nothing claims it.
    expect(groundAt(map, { x: 300, y: 360 })).toBe("unmade");
  });

  it("does not let a region over a road resurface it", () => {
    const map = overlapping();
    map.outdoor.regions!.push({
      id: "weeds",
      kind: "undergrowth",
      points: [{ x: 0, y: 180 }, { x: 200, y: 180 }, { x: 200, y: 240 }, { x: 0, y: 240 }],
    });
    /**
     * Weeds authored right across the carriageway still answer road.
     *
     * This is the case the ordering exists for, and it is not hypothetical: the fairground
     * region deliberately laps undergrowth over made ground to show the place going back to
     * nature. A trail scuffed onto asphalt because a polygon overlapped it is the defect.
     */
    expect(groundAt(map, { x: 100, y: 210 })).toBe("road");
  });

  it("calls soft only what has something loose or living on it", () => {
    const soft: GroundUse[] = ["verge", "undergrowth", "clearing", "ballast"];
    const hard: GroundUse[] = [
      "footway", "forecourt", "plaza", "yard", "court", "water", "road", "unmade",
    ];
    for (const use of soft) expect(isSoftGround(use), use).toBe(true);
    for (const use of hard) expect(isSoftGround(use), use).toBe(false);
  });

  /**
   * THE FEATURE HAS SOMEWHERE TO HAPPEN.
   *
   * A trail pool, a stride and a mark shape are all worth nothing if the world a player walks
   * has no soft ground in it, and that failure is completely silent — the code runs, stamps
   * nothing, and looks correct in every unit test written about the pool. So the world is
   * sampled on a coarse grid and the answer is a real number.
   *
   * The bar is deliberately low (one part in fifty). It is a smoke alarm for a region being
   * re-paved or the region list being dropped, not a target for how much of the world should
   * be soft — that is a level-design question and it belongs to whoever is authoring.
   */
  it("leaves the world real soft ground to mark", () => {
    const step = 40;
    let soft = 0;
    let total = 0;
    const seen = new Set<GroundUse>();
    for (let x = step / 2; x < worldMap.width; x += step) {
      for (let y = step / 2; y < worldMap.height; y += step) {
        const use = groundAt(worldMap, { x, y });
        seen.add(use);
        total += 1;
        if (isSoftGround(use)) soft += 1;
      }
    }
    expect(total).toBeGreaterThan(1000);
    expect(soft / total).toBeGreaterThan(0.02);
    // And it is not one lonely kind holding the whole feature up.
    expect([...seen].filter(isSoftGround).length).toBeGreaterThanOrEqual(2);
  });

  it("never calls paving soft, on the real map", () => {
    for (const surface of worldMap.outdoor.surfaces ?? []) {
      if (surface.kind !== "footway" && surface.kind !== "plaza") continue;
      const at = { x: surface.x + surface.w / 2, y: surface.y + surface.h / 2 };
      // A road or a region may legitimately cover the middle of a footway; what may never
      // happen is the paving itself answering soft.
      const use = groundAt(worldMap, at);
      if (use === "footway" || use === "plaza") expect(isSoftGround(use)).toBe(false);
    }
  });
});
