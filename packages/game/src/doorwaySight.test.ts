import { describe, expect, it } from "vitest";
import { downtownMap } from "./content/downtown";
import { buildingMouths, perimeterEntrances } from "./entrances";
import { contextKey } from "./mapModel";
import { OUTDOOR_FLOOR_ID, type Vec2 } from "./types";
import { DOORWAY_SIGHT, doorwayReach, seesThroughDoorway } from "./visibility";


/**
 * You should not be able to hold a doorway from outside it in perfect safety.
 *
 * Raised from play reasoning rather than from a bug: "when standing in front of a doorway,
 * you should be able to see a certain radius into that doorway. That way, people aren't
 * hiding outside buildings waiting for people to come out."
 *
 * The situation was worse than a fog problem. `contextKey` puts the street and a
 * building's ground floor in different ARENAS — physically joined by the door, but every
 * "can these two interact" question starts by comparing context keys, so a bot on the
 * pavement and a bot two feet inside the lobby could not see, target, or be targeted by
 * each other at all. Camping an exit was not favourable, it was airtight.
 *
 * These run against the real map's real doors, because the rule is about authored
 * geometry — a fixture with one tidy door would not catch a building whose only entrance
 * is a roll-up, or one with two doors on the same elevation.
 */

const OUT = OUTDOOR_FLOOR_ID;

/** Every building with a way in, and the mouth of its first entrance. */
function entranceCases() {
  return downtownMap.buildings
    .map((building) => ({ building, mouths: buildingMouths(downtownMap, building.id) }))
    .filter((entry) => entry.mouths.length > 0);
}

/**
 * A point `distance` along the inward normal from a mouth, and its mirror outside.
 *
 * Derived from the entrance's own side rather than guessed, because "inside" is a
 * different axis for a door in the north wall than for one in the east.
 */
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

describe("the map has doors to test against", () => {
  it("finds perimeter entrances on real buildings", () => {
    // Guards everything below: with no mouths every assertion would be vacuous.
    const cases = entranceCases();
    expect(cases.length).toBeGreaterThan(2);
    for (const { building, mouths } of cases) {
      expect(mouths.length, `${building.id} mouths`).toBeGreaterThan(0);
    }
  });

  it("puts a bot just inside a door in a different arena from one just outside", () => {
    /**
     * The premise of the whole feature, asserted rather than assumed. If these two
     * positions ever landed in the same context, the rule below would be dead code that
     * still passed its own tests.
     */
    let split = 0;
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 30);
      if (!pair) continue;
      const inside = contextKey(downtownMap, OUT, pair.inside);
      const outside = contextKey(downtownMap, OUT, pair.outside);
      if (inside !== outside) split += 1;
    }
    expect(split).toBeGreaterThan(0);
  });
});

describe("seesThroughDoorway", () => {
  it("lets a bot inside and a bot outside see each other across the threshold", () => {
    let linked = 0;
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 30);
      if (!pair) continue;
      if (contextKey(downtownMap, OUT, pair.inside) === contextKey(downtownMap, OUT, pair.outside)) continue;
      expect(
        seesThroughDoorway(downtownMap, OUT, pair.inside, OUT, pair.outside),
        `${building.id} inside→outside`,
      ).toBe(true);
      linked += 1;
    }
    expect(linked).toBeGreaterThan(0);
  });

  it("is symmetric — the camper is seen exactly when they can see", () => {
    /**
     * Load-bearing, and the thing that makes this fair rather than a buff. A one-way rule
     * would only move the unfairness: reveal the camper and the person leaving is now the
     * one with free information.
     */
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 30);
      if (!pair) continue;
      const forward = seesThroughDoorway(downtownMap, OUT, pair.inside, OUT, pair.outside);
      const back = seesThroughDoorway(downtownMap, OUT, pair.outside, OUT, pair.inside);
      expect(back, `${building.id} symmetry`).toBe(forward);
    }
  });

  /**
   * An ABSOLUTE distance, deliberately not `DOORWAY_SIGHT * 3`.
   *
   * It was that, and mutation testing caught it: raising the constant to 4000 — which
   * turns every doorway into a permanent hole in the fog visible from across the map —
   * left the whole suite green, because the "too far" points scaled with the constant they
   * were supposed to be bounding. A test written in terms of the thing under test cannot
   * bound it.
   *
   * 340 units is further than any room on the map is deep and further than the street is
   * wide, so a rule that fires at this range is broken whatever the constant says.
   */
  const FAR = 340;

  it("does not reach across a room — both sides must be near the SAME mouth", () => {
    // Otherwise a doorway is a hole in the fog to be watched from anywhere in the
    // building, which is not "standing in front of" it.
    for (const { building } of entranceCases()) {
      const far = acrossMouth(building.id, FAR);
      if (!far) continue;
      expect(
        seesThroughDoorway(downtownMap, OUT, far.inside, OUT, far.outside),
        `${building.id} at ${FAR} units`,
      ).toBe(false);
    }
  });

  it("needs BOTH sides close, not just one", () => {
    // The asymmetric failure: someone standing in the doorway seeing a bot right across
    // the street, or vice versa. Each of these has one party well outside the radius.
    for (const { building } of entranceCases()) {
      const near = acrossMouth(building.id, 20);
      const far = acrossMouth(building.id, FAR);
      if (!near || !far) continue;
      expect(seesThroughDoorway(downtownMap, OUT, near.inside, OUT, far.outside)).toBe(false);
      expect(seesThroughDoorway(downtownMap, OUT, far.inside, OUT, near.outside)).toBe(false);
    }
  });

  it("keeps the budget in a band that means 'standing in front of it'", () => {
    /**
     * The constant pinned directly, because the geometry tests above can only catch a
     * radius wide enough to cross a whole room — and the damage starts long before that.
     *
     * This is now a SHARED budget rather than a radius per party, so the numbers moved:
     * two bots each 90 units from a mouth are at the limit, and someone standing in the
     * gap sees 180 units past it. Below about 120 the rule barely reaches out of the
     * reveal; past about 300 a doorway stops being a threshold and becomes a window.
     */
    expect(DOORWAY_SIGHT).toBeGreaterThanOrEqual(120);
    expect(DOORWAY_SIGHT).toBeLessThanOrEqual(300);
  });

  it("grants sight continuously, with no step for the fog to flicker on", () => {
    /**
     * THE JITTER BUG, as a property.
     *
     * The first version gave each party a fixed 96-unit radius, which makes the granted
     * region a step function: nothing at 97 units from the mouth, the entire disc at 95.
     * Sliding along a wall past a door crossed that step repeatedly and the fog flashed on
     * and off — reported from play as "shifting left and right in the doorway causes the
     * fog to be quite jittery".
     *
     * A shared budget is continuous by construction, and this is what says so: reach only
     * ever decreases as you back away, never by more than you moved, and it arrives at
     * exactly zero rather than falling off a cliff.
     */
    let previous = doorwayReach(0);
    expect(previous).toBe(DOORWAY_SIGHT);
    for (let distance = 1; distance <= DOORWAY_SIGHT + 60; distance += 1) {
      const reach = doorwayReach(distance);
      expect(reach, `reach at ${distance}`).toBeLessThanOrEqual(previous);
      expect(previous - reach, `jump at ${distance}`).toBeLessThanOrEqual(1.0001);
      previous = reach;
    }
    expect(doorwayReach(DOORWAY_SIGHT)).toBe(0);
    expect(doorwayReach(DOORWAY_SIGHT + 500)).toBe(0);
  });

  it("spends the budget between the two of them, so it stays symmetric", () => {
    /**
     * The sum is the rule, and this test is why it is written that way.
     *
     * The obvious spelling is `db <= doorwayReach(da)` — reuse the renderer's radius as the
     * predicate. It is asymmetric at the boundary and this caught it: a viewer standing IN
     * the gap against a bot at 181 gives `181 <= 180` = false one way, and `0 <= max(0, -1)
     * = 0` = TRUE the other. The `Math.max` that keeps a radius from going negative is
     * exactly what breaks it. So the sum is stated directly and `doorwayReach` is only ever
     * used to draw.
     */
    const sees = (da: number, db: number) => da + db <= DOORWAY_SIGHT;
    for (const [da, db] of [[0, 180], [90, 90], [180, 0], [100, 79], [60, 121], [0, 181], [120, 61]]) {
      expect(sees(da, db), `${da}/${db}`).toBe(sees(db, da));
    }
    for (const [da, db] of [[91, 91], [0, 181], [120, 61]]) {
      expect(sees(da, db), `${da}/${db} beyond budget`).toBe(false);
    }
    // And the radius is still what the renderer should draw, clamp included.
    expect(doorwayReach(200)).toBe(0);
    expect(doorwayReach(60)).toBe(DOORWAY_SIGHT - 60);
  });

  it("says nothing about two bots already in the same arena", () => {
    /**
     * It must return false there, not true. Same-arena sighting goes through
     * `hasLineOfSight`, and `canSee` treats a doorway hit as a reason to SKIP the wall
     * test — so a doorway rule that fired inside one context would hand out sight through
     * interior walls near every entrance.
     */
    for (const { building } of entranceCases()) {
      const pair = acrossMouth(building.id, 26);
      if (!pair) continue;
      expect(seesThroughDoorway(downtownMap, OUT, pair.inside, OUT, pair.inside)).toBe(false);
      expect(seesThroughDoorway(downtownMap, OUT, pair.outside, OUT, pair.outside)).toBe(false);
    }
  });

  it("does not apply between floors, however close the positions look", () => {
    /**
     * Two bots at the same x,y one storey apart are 30 units from a mouth on paper. A
     * doorway is a hole in a WALL, not in a slab, so the upper floor must stay opaque —
     * the check on the physics floor is what stops a stairwell from becoming a window.
     */
    const upper = downtownMap.buildings
      .flatMap((building) => building.floors.map((floor) => ({ building, floor })))
      .find((entry) => entry.floor.label === "F2" && buildingMouths(downtownMap, entry.building.id).length > 0);
    expect(upper, "a tower with doors and an F2").toBeDefined();
    const pair = acrossMouth(upper!.building.id, 30)!;
    expect(seesThroughDoorway(downtownMap, upper!.floor.id, pair.inside, OUT, pair.outside)).toBe(false);
    expect(seesThroughDoorway(downtownMap, OUT, pair.inside, upper!.floor.id, pair.outside)).toBe(false);
  });

  it("puts every mouth on its own footprint's edge", () => {
    /**
     * The renderer's fast path depends on this and cannot state it itself.
     *
     * `doorwayEyes` rejects a whole building with one rect-distance test before it
     * measures any mouth — which is what keeps the per-frame cost flat at a hundred
     * buildings instead of four. That reject is only sound while a mouth lies ON the
     * footprint boundary: a mouth further outside the footprint than the reach would be
     * skipped for a player standing right in front of it.
     *
     * `perimeterEntrances` guarantees it with a 12-unit tolerance, so this asserts the
     * guarantee rather than trusting the two files to keep agreeing.
     */
    for (const { building, mouths } of entranceCases()) {
      const fp = building.footprint;
      for (const mouth of mouths) {
        const toEdge = Math.min(
          Math.abs(mouth.x - fp.x),
          Math.abs(mouth.x - (fp.x + fp.w)),
          Math.abs(mouth.y - fp.y),
          Math.abs(mouth.y - (fp.y + fp.h)),
        );
        expect(toEdge, `${building.id} mouth at (${mouth.x},${mouth.y})`).toBeLessThanOrEqual(12);
      }
    }
  });

  it("grants nothing at a building with no way in", () => {
    // A footprint with no perimeter door has no mouths, so the loop finds nothing rather
    // than falling back to the footprint edge.
    const sealed = { id: "nowhere" };
    expect(buildingMouths(downtownMap, sealed.id)).toEqual([]);
  });
});
