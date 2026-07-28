import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import { downtownMap } from "@dotbot/game/content/downtown";
import { FLAT_KINDS, isSolidObject, SURFACE_KINDS } from "@dotbot/game/mapModel";
import type { MapObject } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { markPassable, PASSABLE_ALPHA, PASSABLE_WASH, SHADOW_ALPHA, type ShadowPad } from "./tone";

/**
 * A thing you can walk through must not draw itself as a thing you cannot.
 *
 * Found by looking at the game: three objects in one screenshot were passable with no
 * cue at all. `mapModel.ts` asserted that flat kinds "are drawn flat with no lift and
 * no shadow precisely so you can see the floor through them" — and for three of the six
 * that was simply false. A vent lifted 2 and cast a shadow, a pallet lifted 3.5 and cast
 * a shadow, and a skylight — a HOLE in a deck — lifted 5 and cast a shadow underneath.
 *
 * That is the same lie #45 and #46 fixed from the other direction, where thirty ghosts
 * were promoted to solid precisely BECAUSE a cast shadow promises cover. These three
 * kept the shadow and stayed walk-through, so the promise pointed the wrong way.
 *
 * A prose comment could not hold this and did not. These assertions run against every
 * object on the real map, so a new glyph that lifts something walk-through fails here.
 */

/** Counts paint operations. Smaller than the `Recorder` in modelWalls.test on purpose:
 *  the claim under test is "nothing was drawn into the shadow pad", not where. */
function counter() {
  let marks = 0;
  const g: Record<string, () => unknown> = {};
  for (const method of ["rect", "roundRect", "poly", "circle", "arc", "ellipse", "moveTo", "lineTo", "closePath", "beginPath", "setStrokeStyle", "setFillStyle"]) {
    g[method] = () => g;
  }
  g.fill = () => {
    marks += 1;
    return g;
  };
  g.stroke = () => {
    marks += 1;
    return g;
  };
  return { g: g as unknown as Graphics, marks: () => marks };
}

function padOf(): { pad: ShadowPad; marks: () => number } {
  const parts = SHADOW_ALPHA.map(() => counter());
  return {
    pad: parts.map((part) => part.g) as ShadowPad,
    marks: () => parts.reduce((total, part) => total + part.marks(), 0),
  };
}

/** Every object on the sheet, indoors and out, with the building it belongs to. */
function everyObject(): Array<{ where: string; object: MapObject }> {
  const found: Array<{ where: string; object: MapObject }> = [];
  for (const building of downtownMap.buildings) {
    for (const floor of building.floors) {
      for (const object of floor.objects) found.push({ where: `${building.id}/${floor.id}`, object });
    }
  }
  for (const object of downtownMap.outdoor.objects) found.push({ where: "outdoor", object });
  return found;
}

const objects = everyObject();
const passableObjects = objects.filter((entry) => !isSolidObject(entry.object));
const solidObjects = objects.filter((entry) => isSolidObject(entry.object));

describe("a passable object casts no shadow", () => {
  it("finds passable objects on the real map at all", () => {
    // Guards the whole file: an empty list would make every assertion below vacuous.
    expect(passableObjects.length).toBeGreaterThan(10);
    expect(solidObjects.length).toBeGreaterThan(100);
  });

  it("writes nothing to the shadow pad, for every walk-through object on the map", () => {
    const offenders: string[] = [];
    for (const { where, object } of passableObjects) {
      const { g } = counter();
      const { pad, marks } = padOf();
      drawModelObject(g, pad, object);
      if (marks() > 0) offenders.push(`${where} ${object.id} (${object.kind})`);
    }
    // Named rather than counted, so a failure says which glyph to open.
    expect(offenders).toEqual([]);
  });

  it("still casts a shadow for everything solid", () => {
    /**
     * The converse, and it is load-bearing. Without it the assertion above passes
     * just as well if `contact` stops working entirely, or if the pad is wired up
     * wrong in this test — a check that cannot fail for the right reason is not a
     * check. A shadow is how the world promises cover, so every solid owes one.
     */
    let withShadow = 0;
    for (const { object } of solidObjects) {
      const { g } = counter();
      const { pad, marks } = padOf();
      drawModelObject(g, pad, object);
      if (marks() > 0) withShadow += 1;
    }
    expect(withShadow).toBe(solidObjects.length);
  });
});

describe("markPassable", () => {
  it("lets the floor through and washes what is left toward white", () => {
    /**
     * Both halves, because either alone was tried and failed. A fainter outline did
     * not read at play zoom, and "no cast shadow" is weaker still — the absence of a
     * cue needs a neighbour to compare against and prior knowledge of the rule.
     *
     * Transparency alone is not enough either: the floor is a mid grey, so a grey
     * fixture at 60% over a grey slab is still a grey rectangle. The white film is
     * what puts it outside the material range every solid lives in.
     */
    const fills: Array<{ color: number; alpha: number }> = [];
    const g = {
      alpha: 1,
      rect: () => g,
      fill: (style: { color: number; alpha: number }) => {
        fills.push(style);
        return g;
      },
    };
    markPassable(g as unknown as Graphics, { x: 0, y: 0, w: 20, h: 20 });

    expect(g.alpha).toBe(PASSABLE_ALPHA);
    expect(g.alpha).toBeLessThan(1);
    expect(fills).toEqual([{ color: 0xffffff, alpha: PASSABLE_WASH }]);
  });

  it("is strong enough to be noticed, not a subtlety", () => {
    // The previous two attempts both failed by being polite. If someone tunes these
    // toward invisibility to make a screenshot look tidier, that is the regression.
    expect(PASSABLE_ALPHA).toBeLessThanOrEqual(0.7);
    expect(PASSABLE_WASH).toBeGreaterThanOrEqual(0.25);
  });
});

describe("the surface exemption", () => {
  it("only exempts things that are already flat and already walk-through", () => {
    // A surface is exempt from the wash because paint cannot be mistaken for cover.
    // If a solid kind ever got in here it would be marked as walkable and not be.
    for (const kind of SURFACE_KINDS) {
      expect(FLAT_KINDS.has(kind), `${kind} must be flat`).toBe(true);
      const probe = { id: "probe", kind, x: 0, y: 0, w: 10, h: 10 } as MapObject;
      expect(isSolidObject(probe), `${kind} must be walk-through`).toBe(false);
    }
  });

  it("leaves the fixture-shaped flat kinds unexempted", () => {
    // vent, skylight and pallet are exactly the three that caused this, so the
    // exemption must not quietly grow to cover them again.
    for (const kind of ["vent", "skylight", "pallet"] as const) {
      expect(SURFACE_KINDS.has(kind)).toBe(false);
    }
  });
});
