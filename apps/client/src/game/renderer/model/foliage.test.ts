import { Graphics } from "pixi.js";
import { describe, expect, it } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { MapObject } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { canopyValueRamp } from "./foliageValues";
import { liftParts } from "./modelMotion";
import { MAT, SHADOW_ALPHA, shade, type ShadowPad } from "./tone";

/**
 * A TREE MUST NOT READ AS A ROCK, and it has now done so twice.
 *
 * First as a cluster of overlapping equal-value circles, which from overhead is a puff of
 * smoke. Then — after that was fixed by going to a closed blob — as a BOULDER, found by
 * rendering the temple forest at play zoom: dark mass, lighter round lobes, flat fills. That
 * is `boulderGlyph` with different numbers. The thickets standing beside it read as vegetation
 * on sight, and `modelLandmarks` already said why: "OUTLINE CARRIES MATERIAL AT LEAST AS HARD
 * AS VALUE DOES ... A closed polygonal outline means STONE in this language whatever tone it
 * is."
 *
 * Twice is a pattern, and a pattern belongs in a check rather than in a comment. What can
 * honestly be pinned about a drawing is not "does it look like a tree" — that is what the lab
 * render is for — but the three structural properties whose absence caused each failure:
 *
 *  1. THE CANOPY IS A MASS WITH A LIT TOP. Flat fills have no top face, which is also why
 *     raising the grounding number for task #79(a) would have changed nothing: object
 *     parallax pulls a top face, and there wasn't one.
 *  2. THE SILHOUETTE IS BROKEN. Lobes straddle the outline rather than sitting inside it.
 *  3. THE TRUNK IS VISIBLE, drawn last, and does not move with the canopy. It is the only
 *     part of a tree that stops you.
 */

/** Records every fill colour, and the radius of every circle, in draw order. */
function recorder() {
  const fills: number[] = [];
  const circles: Array<{ x: number; y: number; r: number }> = [];
  const g: Record<string, (...args: never[]) => unknown> = {};
  for (const method of ["rect", "roundRect", "poly", "arc", "ellipse", "moveTo", "lineTo", "closePath", "beginPath", "setStrokeStyle", "setFillStyle"]) {
    g[method] = () => g;
  }
  g.circle = ((x: number, y: number, r: number) => {
    circles.push({ x, y, r });
    return g;
  }) as never;
  g.fill = ((style: { color?: number } | number | undefined) => {
    const color = typeof style === "number" ? style : style?.color;
    if (typeof color === "number") fills.push(color);
    return g;
  }) as never;
  g.stroke = () => g;
  return { g: g as unknown as Graphics, fills, circles };
}

const pad = (): ShadowPad => SHADOW_ALPHA.map(() => recorder().g) as ShadowPad;

const trees = downtownMap.outdoor.objects.filter((o) => o.kind === "tree");

describe("a canopy is foliage, not stone", () => {
  it("opens the value range for a forest crown without adding a second geometry rule", () => {
    const street = canopyValueRamp(30);
    const forest = canopyValueRamp(60);
    expect(forest.under).toBeLessThan(street.under);
    expect(forest.crown).toBeGreaterThan(street.crown);
    expect(forest.rimShade).toBeLessThan(street.rimShade);
    expect(forest.rimLight).toBeGreaterThan(street.rimLight);
  });

  it("has trees to check", () => {
    expect(trees.length).toBeGreaterThan(20);
  });

  it("gives every canopy a value ramp that reaches its own lit tone", () => {
    for (const tree of trees) {
      const sink = recorder();
      drawModelObject(sink.g, pad(), tree);
      const foliage = new Set(sink.fills);
      /**
       * A LIT crown, at or above `MAT.foliage.top`.
       *
       * This is the assertion that would have caught the boulder reading. The version that
       * read as rock topped out at 0.88 of `MAT.foliage.top` while the thickets beside it
       * topped out AT it, so in a world with no colour the trees had borrowed the rock's half
       * of the only channel left.
       */
      expect([...foliage].some((color) => color >= MAT.foliage.top), tree.id).toBe(true);
      // And a genuinely dark underside, so the mass has a bottom as well as a top.
      expect([...foliage].some((color) => color <= shade(MAT.foliage.top, 0.62)), tree.id).toBe(true);
      // Several distinct steps between them: two tones is a disc with a lid on it.
      expect(foliage.size, tree.id).toBeGreaterThan(3);
    }
  });

  it("breaks the silhouette instead of sitting inside it", () => {
    for (const tree of trees) {
      const sink = recorder();
      drawModelObject(sink.g, pad(), tree);
      const cx = tree.x + tree.w / 2;
      const cy = tree.y + tree.h / 2;
      const radius = Math.min(tree.w, tree.h) / 2;
      /**
       * Lobes that straddle the outline: centre inside, edge outside.
       *
       * The failed version put them at 0.94..1.06 of the radius at a tenth to a fifth of its
       * SIZE, which barely broke the outline and left a rock with a stubbled edge. Straddling
       * is the property that matters — entirely outside reads as litter on the ground,
       * entirely inside leaves the silhouette smooth.
       */
      const straddling = sink.circles.filter((c) => {
        const d = Math.hypot(c.x - cx, c.y - cy);
        return Math.abs(d - radius) < c.r;
      });
      expect(straddling.length, tree.id).toBeGreaterThan(8);
    }
  });

  it("keeps the trunk under the canopy, with the crown parting over it", () => {
    for (const tree of trees) {
      const view = new Graphics();
      drawModelObject(view, pad(), tree);
      /**
       * ONE registered part: the swaying canopy. The trunk is in the base.
       *
       * It was briefly drawn as a second, still child ON TOP of the canopy, so that the only
       * part of a tree which stops you would be visible. Reported and reversed: "seeing the top
       * of the trunk like this through the canopy is a bit odd?" — a 5-to-9-unit disc centred on
       * a lit crown reads as a bolt head, which says *object* where the truth is *tree*.
       *
       * What replaces it is a parting: a dark thinning at the centre of the canopy with no ring
       * and no edge, drawn ON the crown so it sways with the leaves it is a gap in. This pins
       * both halves — the trunk stays in the base, while the canopy is the sole part
       * the outdoor builder lifts into its overhead Container.
       */
      expect(view.children, tree.id).toHaveLength(0);
      expect(liftParts(view), tree.id).toHaveLength(1);
      expect(liftParts(view)[0].label, tree.id).toBe("ambient:sway");
      // Geometry in the base too, which is where the trunk went.
      expect(view.context.instructions.length, tree.id).toBeGreaterThan(0);
    }
  });

  it("keeps the canopy the only thing allowed past the footprint", () => {
    /**
     * A canopy may overhang and nothing else may.
     *
     * `passable.test.ts` guards the other half of this — that a walk-through thing draws no
     * shadow — and the pair is the whole contract for a tree: the trunk is the collider, the
     * leaves are scenery you walk under. The bound is generous (a quarter of the radius)
     * because a fringe lobe is meant to hang out; it exists to catch a canopy drawn at twice
     * its authored size, which is how "trees are too small" gets fixed by accident.
     */
    for (const tree of trees) {
      const sink = recorder();
      drawModelObject(sink.g, pad(), tree);
      const cx = tree.x + tree.w / 2;
      const cy = tree.y + tree.h / 2;
      const radius = Math.min(tree.w, tree.h) / 2;
      for (const circle of sink.circles) {
        const reach = Math.hypot(circle.x - cx, circle.y - cy) + circle.r;
        expect(reach, `${tree.id} lobe at ${circle.x},${circle.y}`).toBeLessThan(radius * 1.25);
      }
    }
  });

  /** A pot plant indoors uses the same function and must not grow a forest canopy. */
  it("holds a small plant down to its pot", () => {
    const plants: MapObject[] = [];
    for (const building of downtownMap.buildings) {
      for (const floor of building.floors) {
        for (const object of floor.objects) if (object.kind === "plant") plants.push(object);
      }
    }
    expect(plants.length).toBeGreaterThan(0);
    for (const plant of plants) {
      const sink = recorder();
      drawModelObject(sink.g, pad(), plant);
      const cx = plant.x + plant.w / 2;
      const cy = plant.y + plant.h / 2;
      const radius = Math.min(plant.w, plant.h) / 2;
      for (const circle of sink.circles) {
        const reach = Math.hypot(circle.x - cx, circle.y - cy) + circle.r;
        // The same quarter-radius bound the trees get. A plant is furniture in a room and a
        // room has 48-unit lanes, so a leaf may overhang its pot and may not eat a lane.
        expect(reach, `${plant.id} leaf at ${circle.x},${circle.y}`).toBeLessThan(radius * 1.25);
      }
    }
  });
});
