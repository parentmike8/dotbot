import { describe, expect, it } from "vitest";
import { pathOutline, polygonBounds } from "@dotbot/game/geometry";
import type { Vec2 } from "@dotbot/game/types";
import { cappedLift, southness, topFace, TOP_FACE_MIN } from "./prism";

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
