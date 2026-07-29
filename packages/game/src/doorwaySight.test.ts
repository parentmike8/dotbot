import { describe, expect, it } from "vitest";
import { downtownMap } from "./content/downtown";
import { buildingMouths, perimeterEntrances } from "./entrances";
import { contextKey, isGroundFloor } from "./mapModel";
import { pointToSolidDistanceSquared, rectSolid } from "./geometry";
import { OUTDOOR_FLOOR_ID, type Vec2 } from "./types";
import { apertureContext, openBuildings, seesOutdoors } from "./visibility";

/**
 * A doorway is a hole in a wall, so sight through it is a shape walls decide.
 *
 * Two attempts before this one, and both are worth keeping in view because the tests here
 * exist to stop either coming back.
 *
 * The first granted sight by proximity to a mouth with no wall test at all, on the argument
 * that the two sides share no occluder list so no ray could be cast. That argument was
 * simply wrong — the lists merge — and the result was what play reported: standing in a
 * doorway lit a full circle, "so even in the rooms to the left and right of the door -
 * those are behind a wall so i shouldn't be able to see to them". The second attempt only
 * changed the radius, which fixed a flicker and none of that.
 *
 * There is no doorway rule now. `apertureContext` swaps a building's footprint for its own
 * ground-floor walls, which already carry genuine gaps at every opening, and an ordinary
 * visibility test does the rest. So the assertions below are mostly about walls still
 * working — which is the part a disc got wrong and cannot be tuned into getting right.
 */

const OUT = OUTDOOR_FLOOR_ID;

function entranceCases() {
  return downtownMap.buildings
    .map((building) => ({ building, mouths: buildingMouths(downtownMap, building.id) }))
    .filter((entry) => entry.mouths.length > 0);
}

/** A point `distance` along the inward normal from a mouth, and its mirror outside. */
function acrossMouth(buildingId: string, distance: number): { inside: Vec2; outside: Vec2 } | null {
  const building = downtownMap.buildings.find((item) => item.id === buildingId)!;
  const entrance = perimeterEntrances(building)[0];
  if (!entrance) return null;
  const { door, side } = entrance;
  const step = { N: { x: 0, y: 1 }, S: { x: 0, y: -1 }, W: { x: 1, y: 0 }, E: { x: -1, y: 0 } }[side];
  return {
    inside: { x: door.x + step.x * distance, y: door.y + step.y * distance },
    outside: { x: door.x - step.x * distance, y: door.y - step.y * distance },
  };
}

/** Standable interior points of a building, on a coarse grid, avoiding its walls. */
function interiorSamples(buildingId: string, step = 40): Vec2[] {
  const building = downtownMap.buildings.find((item) => item.id === buildingId)!;
  const ground = building.floors.find(isGroundFloor);
  const solids = (ground?.walls ?? []).map(rectSolid);
  const fp = building.footprint;
  const out: Vec2[] = [];
  for (let x = fp.x + step; x < fp.x + fp.w; x += step) {
    for (let y = fp.y + step; y < fp.y + fp.h; y += step) {
      const point = { x, y };
      if (solids.some((solid) => pointToSolidDistanceSquared(point, solid) <= 0)) continue;
      out.push(point);
    }
  }
  return out;
}

describe("apertureContext", () => {
  it("replaces an opened building's footprint with its own walls", () => {
    /**
     * The structural claim the whole mechanic rests on. A footprint is one opaque rect; a
     * ground floor's walls are many rects with gaps cut at the openings. Swapping them is
     * what turns "vision stops at the elevation" into "vision goes through the door".
     */
    const target = entranceCases()[0].building;
    const closed = apertureContext(downtownMap, []);
    const opened = apertureContext(downtownMap, [target.id]);
    expect(opened.walls.length).toBeGreaterThan(closed.walls.length);

    const fp = target.footprint;
    const isFootprintEdge = (w: { ax: number; ay: number; bx: number; by: number }) =>
      Math.abs(w.ax - fp.x) < 0.01 && Math.abs(w.ay - fp.y) < 0.01
      && Math.abs(w.bx - (fp.x + fp.w)) < 0.01 && Math.abs(w.by - fp.y) < 0.01;
    expect(closed.walls.some(isFootprintEdge)).toBe(true);
    expect(opened.walls.some(isFootprintEdge)).toBe(false);
  });

  it("bounds the whole map, so sight can leave a building", () => {
    // The per-building context bounds rays at the footprint, which is why standing inside
    // used to see nothing outside however open the door was.
    const context = apertureContext(downtownMap, []);
    expect(context.boundsRect).toEqual({ x: 0, y: 0, w: downtownMap.width, h: downtownMap.height });
  });

  it("opens only what is near, so the occluder set stays small", () => {
    // Spatial filter rather than a list — the scale-first rule. A viewer in one corner of
    // the map must not be paying for every building's interior walls.
    const corner = openBuildings(downtownMap, { x: 20, y: 20 });
    const all = downtownMap.buildings.map((building) => building.id);
    expect(corner.length).toBeLessThan(all.length);
  });
});

describe("the premise", () => {
  it("still puts inside and outside a door in different arenas", () => {
    // If these ever matched, the merged-geometry path below would be dead code.
    let split = 0;
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 30);
      if (!pair) continue;
      if (contextKey(downtownMap, OUT, pair.inside) !== contextKey(downtownMap, OUT, pair.outside)) split += 1;
    }
    expect(split).toBeGreaterThan(0);
  });
});

describe("seesOutdoors", () => {
  it("sees straight through a doorway, both ways", () => {
    let linked = 0;
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 34);
      if (!pair) continue;
      expect(seesOutdoors(downtownMap, OUT, pair.inside, OUT, pair.outside), building.id).toBe(true);
      expect(seesOutdoors(downtownMap, OUT, pair.outside, OUT, pair.inside), `${building.id} back`).toBe(true);
      linked += 1;
    }
    expect(linked).toBeGreaterThan(2);
  });

  it("IS NOT A DISC — a nearer point can be hidden while a further one is seen", () => {
    /**
     * THE BUG THIS REPLACED, stated as the property that actually distinguishes the two
     * implementations rather than as a number.
     *
     * A disc makes visibility a function of DISTANCE ALONE: everything inside the radius is
     * lit, whatever is between. So under a disc, visibility is monotone — no hidden point
     * can be nearer than a visible one. Real geometry breaks that constantly, because a
     * partition three feet away hides a room while the hall keeps going past it. Play saw
     * exactly the monotone version: "even in the rooms to the left and right of the door -
     * those are behind a wall so i shouldn't be able to see to them".
     *
     * A first attempt at this test asserted "less than half the interior is visible", which
     * failed on Civic — and Civic was right: its ground floor is one open lobby, so more than
     * half of it genuinely IS visible from the door. An arbitrary fraction measures the floor
     * plan, not the rule.
     */
    let checked = 0;
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 40);
      const samples = interiorSamples(building.id);
      if (!pair || samples.length < 12) continue;
      const range = (point: Vec2) => Math.hypot(point.x - pair.outside.x, point.y - pair.outside.y);
      const seen = samples.filter((point) => seesOutdoors(downtownMap, OUT, pair.outside, OUT, point));
      const hidden = samples.filter((point) => !seesOutdoors(downtownMap, OUT, pair.outside, OUT, point));
      expect(seen.length, `${building.id} sees nothing inside`).toBeGreaterThan(0);
      expect(hidden.length, `${building.id} sees everything inside`).toBeGreaterThan(0);

      const furthestSeen = Math.max(...seen.map(range));
      const nearestHidden = Math.min(...hidden.map(range));
      expect(
        nearestHidden,
        `${building.id}: nearest hidden point is ${Math.round(nearestHidden)} away, furthest seen ${Math.round(furthestSeen)} — visibility is monotone in distance, i.e. a disc`,
      ).toBeLessThan(furthestSeen);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("does not see the far side of a building from its own doorstep", () => {
    // The strongest single case: the sample furthest from the door, which is behind at
    // least one partition in every building on the map.
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 40);
      const samples = interiorSamples(building.id);
      if (!pair || !samples.length) continue;
      const furthest = samples.reduce((best, point) =>
        Math.hypot(point.x - pair.outside.x, point.y - pair.outside.y)
        > Math.hypot(best.x - pair.outside.x, best.y - pair.outside.y) ? point : best);
      expect(seesOutdoors(downtownMap, OUT, pair.outside, OUT, furthest), building.id).toBe(false);
    }
  });

  it("is symmetric everywhere, because a ray crosses a wall in both directions", () => {
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 40);
      const samples = interiorSamples(building.id);
      if (!pair) continue;
      for (const point of samples.slice(0, 24)) {
        expect(
          seesOutdoors(downtownMap, OUT, pair.outside, OUT, point),
          `${building.id} ${point.x},${point.y}`,
        ).toBe(seesOutdoors(downtownMap, OUT, point, OUT, pair.outside));
      }
    }
  });

  it("does not apply between floors, however close the positions look", () => {
    /**
     * Two bots at the same x,y one storey apart. A doorway is a hole in a WALL, not in a
     * slab, so the check on the physics floor is what stops a stairwell being a window.
     */
    const upper = downtownMap.buildings
      .flatMap((building) => building.floors.map((floor) => ({ building, floor })))
      .find((entry) => entry.floor.label === "F2" && buildingMouths(downtownMap, entry.building.id).length > 0);
    expect(upper, "a tower with doors and an F2").toBeDefined();
    const pair = acrossMouth(upper!.building.id, 30)!;
    expect(seesOutdoors(downtownMap, upper!.floor.id, pair.inside, OUT, pair.outside)).toBe(false);
    expect(seesOutdoors(downtownMap, OUT, pair.inside, upper!.floor.id, pair.outside)).toBe(false);
  });

  it("opens the target's building too, not only the viewer's", () => {
    /**
     * A bot deep inside a building the viewer is standing far from would otherwise be
     * hidden behind its own footprint — the merge has to cover both endpoints or the rule
     * is asymmetric in the one case that matters, which is two people at one door.
     */
    const cases = entranceCases();
    expect(cases.length).toBeGreaterThan(1);
    for (const { building } of cases) {
      const pair = acrossMouth(building.id, 34);
      if (!pair) continue;
      // `openBuildings` from the outside point may or may not include this building
      // depending on range; the rule must not depend on that.
      const near = openBuildings(downtownMap, pair.outside);
      expect(near, `${building.id} near list`).toContain(building.id);
    }
  });
});
