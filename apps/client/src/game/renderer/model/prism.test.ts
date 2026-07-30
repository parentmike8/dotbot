import { describe, expect, it } from "vitest";
import { insetPolygon, pathOutline, polygonBounds, polygonContains } from "@dotbot/game/geometry";
import type { Vec2 } from "@dotbot/game/types";
import { awayness, cappedLift, NORTH, PARALLAX_HORIZON, pullToward, southness, topFace, topRect, TOP_FACE_MIN } from "./prism";

/** Clockwise on screen, which is what `edgeNormal` reads as outward. */
function rect(x: number, y: number, w: number, h: number): Vec2[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/** How deep the front face ends up: the gap between footprint and top face. */
function frontDepth(points: Vec2[], lift: number): number {
  const foot = polygonBounds(points);
  const top = polygonBounds(topFace(points, lift));
  return foot.y + foot.h - (top.y + top.h);
}

const WALL = 12;
const LIFT = 10;

describe("southness", () => {
  it("moves a vertex with its most southward face, not the average of two", () => {
    // A rectangle's south-east corner joins an east face to a south face. The east
    // face has nothing to say about height; averaging lets it halve the corner.
    expect(southness({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(southness({ x: 0, y: 1 }, { x: -1, y: 0 })).toBe(1);
  });

  it("leaves a north corner on the ground", () => {
    expect(southness({ x: -1, y: 0 }, { x: 0, y: -1 })).toBe(0);
    expect(southness({ x: 0, y: -1 }, { x: 1, y: 0 })).toBe(0);
  });
});

describe("cappedLift", () => {
  it("keeps a column's top face rather than letting the front face eat it", () => {
    expect(cappedLift(16, 11)).toBeCloseTo(16 * (1 - TOP_FACE_MIN), 6);
  });

  it("leaves a lift that fits alone", () => {
    expect(cappedLift(90, 9)).toBe(9);
  });
});

describe("topFace", () => {
  it("draws a rectangle exactly as volume() does", () => {
    // The claim tone.ts makes about itself, and the one that has to hold: the two
    // primitives are the same rule, so a wall run and a pier cannot disagree.
    const r = rect(0, 0, 100, WALL);
    expect(frontDepth(r, LIFT)).toBeCloseTo(cappedLift(WALL, LIFT), 6);
  });

  it("gives a wall run the same front face as a pier of the same thickness", () => {
    // drawBarrier draws runs through volumeShape and the pier left beside a door
    // through volume. A step between them at every doorway is the visible cost.
    const run = pathOutline([{ x: 0, y: 0 }, { x: 400, y: 0 }], WALL);
    expect(frontDepth(run, LIFT)).toBeCloseTo(cappedLift(WALL, LIFT), 6);
  });

  it("keeps the silhouette: no vertex leaves the footprint", () => {
    const l = pathOutline([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }], WALL);
    const foot = polygonBounds(l);
    for (const [index, point] of topFace(l, LIFT).entries()) {
      expect(point.x).toBe(l[index].x);
      expect(point.y).toBeLessThanOrEqual(l[index].y);
      expect(point.y).toBeGreaterThanOrEqual(foot.y);
    }
  });

  it("holds an arm's depth at an inner corner", () => {
    // The reflex vertex where the two arms meet joins a west face to a south face.
    // Averaging their normals lifts it only half as far as the south edge it sits
    // on, which notches the top face at every corner a wall turns.
    const l = pathOutline([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }], WALL);
    const inner = topFace(l, LIFT).find((point) => Math.abs(point.x - 194) < 0.01 && point.y < 150);
    expect(inner).toBeDefined();
    expect(inner!.y).toBeCloseTo(106 - cappedLift(WALL, LIFT), 6);
  });

  it("gives each arm of a turning wall the depth it has room for", () => {
    // An L's bounding box is 112 across and its area stays comfortable while one
    // arm collapses, so the cap is measured at each vertex instead. The east-west
    // arm is 12 deep and the north-south one is 100.
    const l = pathOutline([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }], WALL);
    const top = topFace(l, LIFT);
    const alongArm = top.find((point) => Math.abs(point.x - 100) < 0.01 && point.y > 100);
    expect(alongArm!.y).toBeCloseTo(106 - cappedLift(WALL, LIFT), 6);
    const armEnd = top.find((point) => Math.abs(point.x - 206) < 0.01 && point.y > 150);
    expect(armEnd!.y).toBeCloseTo(200 - LIFT, 6);
  });

  it("never lifts a north face", () => {
    const r = rect(0, 0, 60, 60);
    const top = topFace(r, LIFT);
    expect(top[0]).toEqual({ x: 0, y: 0 });
    expect(top[1]).toEqual({ x: 60, y: 0 });
  });
});

/**
 * Which way the top slides.
 *
 * A solid's height is drawn by pulling its top face away from the viewer, and that pull
 * was nailed to north — so an object's height read as a fixed south band no matter where
 * the camera stood, while buildings had been sliding their mass with the camera since
 * #37. These are the tests for the generalisation: the pull is a direction now.
 *
 * Nothing passes a direction yet, so every existing drawing is unchanged. That is the
 * first thing asserted, because a refactor of the primitive the whole language rests on
 * has to be provably invisible before anything is allowed to use it.
 */
describe("an arbitrary pull direction", () => {
  const dir = (radians: number): Vec2 => ({ x: Math.cos(radians), y: Math.sin(radians) });
  /** Sixteen directions round the circle, none of them axis-aligned by accident. */
  const sweep = Array.from({ length: 16 }, (_, i) => dir((i / 16) * Math.PI * 2 + 0.11));
  const shapes = [
    rect(0, 0, 100, WALL),
    rect(0, 0, 60, 60),
    pathOutline([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }], WALL),
    pathOutline([{ x: 0, y: 0 }, { x: 90, y: 40 }], 20),
  ];

  it("reduces to the fixed north pull, exactly", () => {
    // The whole safety of this change. `NORTH` has to be bit-for-bit what the old
    // hardcoded version produced, or every solid in the game moves a little.
    for (const shape of shapes) {
      expect(topFace(shape, LIFT, NORTH)).toEqual(topFace(shape, LIFT));
    }
  });

  it("agrees with southness on every normal, for a north pull", () => {
    // Not spot checks: `southness` is now `awayness(_, _, NORTH)`, so they have to
    // coincide across the circle rather than at the four corners somebody thought of.
    for (const incoming of sweep) {
      for (const outgoing of sweep) {
        expect(awayness(incoming, outgoing, NORTH)).toBeCloseTo(southness(incoming, outgoing), 12);
      }
    }
  });

  it("keeps the silhouette whichever way it pulls", () => {
    /**
     * Contract §2, and the reason this generalisation is safe to make at all: the drawn
     * shape is the collider. A top face that escapes the footprint is a solid you can
     * see and walk through, or walk into and not see — at any camera angle, for every
     * object in the world at once.
     */
    for (const shape of shapes) {
      /**
       * Against the footprint grown by a thousandth of a unit, because a vertex that
       * does not move stays exactly ON the boundary and `polygonContains` is a strict
       * interior test. The first pass reported an unmoved corner as an escape. The
       * tolerance is four orders of magnitude below the real fault this caught — a
       * north-east corner pulled 1.09 units clean outside a 100-wide rect.
       */
      const grown = insetPolygon(shape, -1e-3);
      for (const pull of sweep) {
        for (const point of topFace(shape, LIFT, pull)) {
          expect(
            polygonContains(grown, point),
            `pull ${pull.x.toFixed(2)},${pull.y.toFixed(2)} put ${point.x.toFixed(2)},${point.y.toFixed(2)} outside`,
          ).toBe(true);
        }
      }
    }
  });

  it("puts the exposed face on the side away from the pull", () => {
    // The visible effect: from north of a box you see its south face, and from south of
    // it you see its north face. Opposite pulls have to expose opposite bands.
    const r = rect(0, 0, 60, 60);
    const north = topFace(r, LIFT, NORTH);
    const south = topFace(r, LIFT, { x: 0, y: 1 });
    // North pull: the south edge rises, the north edge stays.
    expect(north[3].y).toBeCloseTo(60 - LIFT, 6);
    expect(north[0].y).toBe(0);
    // South pull: the mirror image.
    expect(south[0].y).toBeCloseTo(LIFT, 6);
    expect(south[3].y).toBe(60);
  });

  it("caps against the depth measured along the pull, not along the page", () => {
    /**
     * A 100-by-12 slab has 12 units of depth north-south and 100 east-west. Pulled
     * north its top face is capped hard; pulled east it has room for the whole lift.
     * Measuring depth with the old vertical scan would have capped both the same way.
     */
    const slab = rect(0, 0, 100, WALL);
    const pulledNorth = topFace(slab, LIFT, NORTH);
    const pulledWest = topFace(slab, LIFT, { x: -1, y: 0 });
    expect(WALL - (pulledNorth[2].y - pulledNorth[1].y)).toBeCloseTo(cappedLift(WALL, LIFT), 6);
    // West pull: the east edge moves the full lift, because there is 100 units to eat.
    expect(pulledWest[1].x).toBeCloseTo(100 - LIFT, 6);
  });

  describe("the rectangle fast path", () => {
    /**
     * `volume` draws rectangles and returns their top face as a `Rect`, which three dozen
     * call sites use to place the detail on a fixture's lid. `topFace` would turn that into
     * a general quad on an oblique pull and there would be nowhere to put the detail — so
     * the rect path uses `topRect`, which shifts the whole face and clips instead of moving
     * each vertex, and stays a rectangle.
     */
    const slab = { x: 0, y: 0, w: 100, h: WALL };
    const square = { x: 10, y: 20, w: 60, h: 60 };

    it("reproduces the rect minus a south band, exactly", () => {
      // What `volume` computed inline for as long as it has existed.
      expect(topRect(slab, LIFT)).toEqual({ x: 0, y: 0, w: 100, h: WALL - cappedLift(WALL, LIFT) });
      expect(topRect(square, LIFT)).toEqual({ x: 10, y: 20, w: 60, h: 60 - LIFT });
    });

    it("keeps the top face inside the footprint, whichever way it pulls", () => {
      // True by construction here — an intersection cannot leave either operand — which is
      // why this path needs no angle sweep to be safe, unlike the polygon one.
      for (const pull of sweep) {
        for (const r of [slab, square]) {
          const top = topRect(r, LIFT, pull);
          expect(top.x).toBeGreaterThanOrEqual(r.x);
          expect(top.y).toBeGreaterThanOrEqual(r.y);
          expect(top.x + top.w).toBeLessThanOrEqual(r.x + r.w + 1e-9);
          expect(top.y + top.h).toBeLessThanOrEqual(r.y + r.h + 1e-9);
        }
      }
    });

    it("caps against the extent along the pull, not always the height", () => {
      /**
       * `volume` capped against `r.h` outright, which was right only because the pull could
       * not turn. Pulled east this 100-by-12 slab has 100 units to eat, and capping it
       * against 12 would hold the exposed face to 5.4 when it has room for the whole lift.
       */
      expect(topRect(slab, LIFT, { x: -1, y: 0 }).w).toBeCloseTo(100 - LIFT, 6);
      expect(WALL - topRect(slab, LIFT, NORTH).h).toBeCloseTo(cappedLift(WALL, LIFT), 6);
    });

    it("moves the face away from the pull, so the exposed band swaps sides", () => {
      // Pulled north the top hugs the north edge and the south band shows; pulled south the
      // mirror image. That swap is the whole visible effect.
      expect(topRect(square, LIFT, NORTH).y).toBe(20);
      expect(topRect(square, LIFT, { x: 0, y: 1 }).y).toBeCloseTo(20 + LIFT, 6);
    });
  });

  describe("which way the camera points the pull", () => {
    const centre = { x: 1000, y: 1000 };
    const unit = (v: Vec2) => Math.hypot(v.x, v.y);

    it("is exactly north at strength zero, so the effect has an off switch", () => {
      for (const at of [{ x: 400, y: 400 }, { x: 1600, y: 1600 }, centre]) {
        expect(pullToward(at, centre, 0)).toEqual(NORTH);
      }
    });

    it("is north for an object the camera is sitting on", () => {
      // No direction to offer, and the caller should not have to special-case it.
      expect(pullToward(centre, centre, 1)).toEqual(NORTH);
    });

    it("always returns a unit vector, including due south at half strength", () => {
      /**
       * The case that rules out blending the vectors instead of the angle: an object due
       * south of the camera at half strength blends `NORTH` and `SOUTH` to exactly zero,
       * and a zero pull has no direction to normalise. It is an ordinary position, not a
       * corner case, so it is swept for here at every strength.
       */
      const dueSouth = { x: 1000, y: 1000 + PARALLAX_HORIZON };
      for (const strength of [0.25, 0.5, 0.75, 1]) {
        expect(unit(pullToward(dueSouth, centre, strength))).toBeCloseTo(1, 12);
      }
      for (const at of [{ x: 400, y: 1600 }, { x: 1900, y: 200 }, { x: 1000, y: 100 }]) {
        expect(unit(pullToward(at, centre, 1))).toBeCloseTo(1, 12);
      }
    });

    it("points away from the camera once it is a horizon out", () => {
      // The visible claim: stand north of a box and you see its south face; stand south of
      // it and you see its north face.
      const south = pullToward({ x: 1000, y: 1000 + PARALLAX_HORIZON }, centre, 1);
      expect(south.x).toBeCloseTo(0, 6);
      expect(south.y).toBeCloseTo(1, 6);

      const east = pullToward({ x: 1000 + PARALLAX_HORIZON, y: 1000 }, centre, 1);
      expect(east.x).toBeCloseTo(1, 6);
      expect(east.y).toBeCloseTo(0, 6);
    });

    it("turns further the further off-axis the object is", () => {
      // Gentle under the player, full at the edge of view — so the floor the player is
      // standing on does not swim while they walk.
      const near = pullToward({ x: 1000, y: 1000 + PARALLAX_HORIZON * 0.25 }, centre, 1);
      const far = pullToward({ x: 1000, y: 1000 + PARALLAX_HORIZON }, centre, 1);
      expect(near.y).toBeLessThan(far.y);
      expect(near.y).toBeGreaterThan(NORTH.y);
    });

    it("carries a distinct distance-based travel magnitude above strength one", () => {
      const at = { x: 1000 + PARALLAX_HORIZON, y: 1000 };
      const half = pullToward(at, centre, 0.5);
      const full = pullToward(at, centre, 1);
      const boosted = pullToward(at, centre, 2);

      expect(half.scale).toBeGreaterThan(1);
      expect(full.scale).toBeGreaterThan(half.scale);
      expect(boosted.scale).toBeGreaterThan(full.scale);

      const box = { x: 0, y: 0, w: 80, h: 80 };
      expect(topRect(box, LIFT, boosted).w).toBeLessThan(topRect(box, LIFT, full).w);
      expect(topRect(box, LIFT, full).w).toBeLessThan(topRect(box, LIFT, half).w);
    });

    it("keeps a bounded readable top while distance adds visible travel", () => {
      /**
       * Magnitude is allowed to expose more face at the edge of view now; that is the
       * visible height cue the old unit-vector law lacked. `cappedLift` is still the hard
       * safety boundary: even the strongest oblique pull keeps a meaningful lid inside
       * the planted silhouette.
       */
      const box = { x: 0, y: 0, w: 60, h: 60 };
      const area = (r: { w: number; h: number }) => r.w * r.h;
      const footprint = area(box);
      for (const at of [{ x: 400, y: 1600 }, { x: 1900, y: 200 }, { x: 1000, y: 1700 }]) {
        const turned = topRect(box, LIFT, pullToward(at, centre, 1));
        expect(area(turned)).toBeGreaterThanOrEqual(footprint * TOP_FACE_MIN * TOP_FACE_MIN);
        expect(area(turned)).toBeLessThanOrEqual(footprint);
      }
    });
  });

  it("leaves the shape flat for a pull of nothing", () => {
    // A camera exactly over an object has no direction to offer, and the caller should
    // not have to special-case it: a zero pull is a solid seen from straight above.
    const r = rect(0, 0, 60, 60);
    expect(topFace(r, LIFT, { x: 0, y: 0 })).toEqual(r);
  });
});
