import { describe, expect, it } from "vitest";
import {
  arcPoints,
  circlePoints,
  edgeNormal,
  filletCorners,
  pathOutline,
  pointToSolidDistanceSquared,
  polygonArea,
  polygonBounds,
  polygonContains,
  segmentToSolidDistanceSquared,
  segmentsIntersect,
  separateCircleFromSolid,
  solidBounds,
  solidSegments,
  insetPolygon,
  thickenPath,
  type Solid,
} from "./geometry";
import type { Rect, Vec2 } from "./types";

const RECT: Solid = { kind: "rect", x: 100, y: 100, w: 200, h: 80 };

/**
 * The shipped circle-vs-rect solver, frozen here verbatim.
 *
 * `collision.separateCircleFromRect` now delegates to the kernel, so comparing
 * against it would be circular. Every bot's movement — server and client
 * prediction alike — resolves through this arithmetic, so the kernel is pinned to
 * a copy that cannot drift when the live one is refactored.
 */
function frozenSeparateCircleFromRect(position: Vec2, radius: number, wall: Rect): Vec2 {
  const clampTo = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high);
  const closestX = clampTo(position.x, wall.x, wall.x + wall.w);
  const closestY = clampTo(position.y, wall.y, wall.y + wall.h);
  const offset = { x: position.x - closestX, y: position.y - closestY };
  const distanceSquared = offset.x * offset.x + offset.y * offset.y;
  if (distanceSquared >= radius * radius) return position;
  if (distanceSquared > 0.0001) {
    const distanceToWall = Math.sqrt(distanceSquared);
    const push = (radius - distanceToWall) / distanceToWall;
    return { x: position.x + offset.x * push, y: position.y + offset.y * push };
  }
  const left = Math.abs(position.x - wall.x);
  const right = Math.abs(wall.x + wall.w - position.x);
  const top = Math.abs(position.y - wall.y);
  const bottom = Math.abs(wall.y + wall.h - position.y);
  const nearest = Math.min(left, right, top, bottom);
  if (nearest === left) return { x: wall.x - radius, y: position.y };
  if (nearest === right) return { x: wall.x + wall.w + radius, y: position.y };
  if (nearest === top) return { x: position.x, y: wall.y - radius };
  return { x: position.x, y: wall.y + wall.h + radius };
}

describe("geometry kernel", () => {
  describe("rect solids stay identical to the shipped collision maths", () => {
    /**
     * The whole point of the kernel is that generalising the primitives changes
     * nothing about the world already authored against rectangles.
     */
    it("separates a circle bit-for-bit as the frozen solver does", () => {
      const wall: Rect = { x: 100, y: 100, w: 200, h: 80 };
      const positions: Vec2[] = [
        { x: 90, y: 140 }, { x: 310, y: 140 }, { x: 200, y: 90 }, { x: 200, y: 190 },
        { x: 105, y: 105 }, { x: 295, y: 175 }, { x: 200, y: 140 }, { x: 500, y: 500 },
        { x: 100, y: 100 }, { x: 300, y: 180 }, { x: 123.456, y: 178.9 }, { x: 99.9, y: 100.1 },
      ];
      for (const position of positions) {
        const frozen = frozenSeparateCircleFromRect(position, 24, wall);
        const kernel = separateCircleFromSolid(position, 24, RECT);
        // Exact equality, not approximate: prediction and the server must agree.
        expect(kernel, `at ${position.x},${position.y}`).toEqual(frozen);
      }
    });

    it("reports zero distance inside and exact distance outside", () => {
      expect(pointToSolidDistanceSquared({ x: 200, y: 140 }, RECT)).toBe(0);
      expect(pointToSolidDistanceSquared({ x: 100 - 3, y: 140 }, RECT)).toBeCloseTo(9, 6);
      expect(pointToSolidDistanceSquared({ x: 96, y: 96 }, RECT)).toBeCloseTo(32, 6);
    });

    it("gives a rect four occluding segments", () => {
      expect(solidSegments(RECT)).toHaveLength(4);
    });
  });

  describe("capsules carry walls at any angle", () => {
    const diagonal: Solid = { kind: "capsule", ax: 0, ay: 0, bx: 100, by: 100, r: 6 };

    it("measures distance perpendicular to the spine", () => {
      // (50,50) is on the spine, so the point is inside the capsule.
      expect(pointToSolidDistanceSquared({ x: 50, y: 50 }, diagonal)).toBe(0);
      // 20 units perpendicular from the spine, minus the 6-unit radius.
      const perpendicular = 20 / Math.SQRT2;
      const point = { x: 50 + perpendicular, y: 50 - perpendicular };
      expect(Math.sqrt(pointToSolidDistanceSquared(point, diagonal))).toBeCloseTo(14, 5);
    });

    it("pushes a circle out along the perpendicular, not an axis", () => {
      const moved = separateCircleFromSolid({ x: 54, y: 46 }, 10, diagonal);
      // Leaving perpendicular to a 45-degree spine moves x and y equally.
      expect(moved.x - 54).toBeCloseTo(-(moved.y - 46), 5);
      expect(Math.sqrt(pointToSolidDistanceSquared(moved, diagonal))).toBeCloseTo(10, 4);
    });

    it("never leaves a bot inside, even dead on the spine", () => {
      const moved = separateCircleFromSolid({ x: 50, y: 50 }, 12, diagonal);
      expect(pointToSolidDistanceSquared(moved, diagonal)).toBeGreaterThan(0);
    });

    it("bounds include the radius on every side", () => {
      expect(solidBounds(diagonal)).toEqual({ x: -6, y: -6, w: 112, h: 112 });
    });

    it("measures a crossing ray as touching", () => {
      expect(segmentToSolidDistanceSquared({ x: 0, y: 100 }, { x: 100, y: 0 }, diagonal)).toBe(0);
    });
  });

  describe("convex polygons", () => {
    // A wedge, wound clockwise in screen space.
    const wedge: Solid = { kind: "poly", points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 0, y: 60 }] };

    it("contains points inside and rejects points outside", () => {
      expect(pointToSolidDistanceSquared({ x: 10, y: 10 }, wedge)).toBe(0);
      expect(pointToSolidDistanceSquared({ x: 50, y: 50 }, wedge)).toBeGreaterThan(0);
    });

    it("pushes a circle clear of the hypotenuse", () => {
      const moved = separateCircleFromSolid({ x: 34, y: 34 }, 8, wedge);
      expect(Math.sqrt(pointToSolidDistanceSquared(moved, wedge))).toBeCloseTo(8, 4);
    });

    it("evacuates a circle whose centre is inside", () => {
      const moved = separateCircleFromSolid({ x: 8, y: 8 }, 6, wedge);
      expect(pointToSolidDistanceSquared(moved, wedge)).toBeGreaterThan(0);
    });
  });

  describe("polygon helpers", () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

    it("measures area and bounds", () => {
      expect(Math.abs(polygonArea(square))).toBeCloseTo(100, 6);
      expect(polygonBounds(square)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    });

    it("handles a concave outline, which is what an L-shaped building is", () => {
      const ell = [
        { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 },
        { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 },
      ];
      expect(polygonContains(ell, { x: 10, y: 10 })).toBe(true);
      expect(polygonContains(ell, { x: 50, y: 10 })).toBe(true);
      // The notch is outside the building.
      expect(polygonContains(ell, { x: 50, y: 50 })).toBe(false);
    });

    it("points every edge normal outward regardless of winding", () => {
      const expectNormal = (normal: { x: number; y: number }, x: number, y: number): void => {
        expect(normal.x).toBeCloseTo(x, 6);
        expect(normal.y).toBeCloseTo(y, 6);
      };
      // Edge 0 runs along the top, so its outward normal points north.
      expectNormal(edgeNormal(square, 0), 0, -1);
      // Left edge faces west.
      expectNormal(edgeNormal(square, 3), -1, 0);
      // Reversed winding still points outward; the top edge is now index 2.
      expectNormal(edgeNormal([...square].reverse(), 2), 0, -1);
    });

    it("detects crossing and non-crossing segments", () => {
      expect(segmentsIntersect({ ax: 0, ay: 0, bx: 10, by: 10 }, { ax: 0, ay: 10, bx: 10, by: 0 })).toBe(true);
      expect(segmentsIntersect({ ax: 0, ay: 0, bx: 4, by: 4 }, { ax: 6, ay: 6, bx: 10, by: 10 })).toBe(false);
    });
  });

  describe("curves become polylines before the runtime sees them", () => {
    it("puts arc points on the circle", () => {
      for (const point of arcPoints({ x: 5, y: 5 }, 10, 0, Math.PI)) {
        expect(Math.hypot(point.x - 5, point.y - 5)).toBeCloseTo(10, 6);
      }
    });

    it("closes a circle without repeating the seam point", () => {
      const points = circlePoints({ x: 0, y: 0 }, 8, 12);
      expect(points).toHaveLength(12);
      expect(points[0]).not.toEqual(points.at(-1));
    });

    it("rounds a corner inside the original turn", () => {
      const sharp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
      const rounded = filletCorners(sharp, 30);
      // Endpoints are preserved; the corner is replaced by an arc.
      expect(rounded[0]).toEqual(sharp[0]);
      expect(rounded.at(-1)).toEqual(sharp.at(-1));
      expect(rounded.length).toBeGreaterThan(sharp.length);
      // No fillet point may sit outside the original corner.
      for (const point of rounded) {
        expect(point.x).toBeLessThanOrEqual(100.0001);
        expect(point.y).toBeLessThanOrEqual(100.0001);
      }
    });

    it("never cuts more than half of the shorter leg", () => {
      const tight = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
      for (const point of filletCorners(tight, 500)) {
        expect(point.x).toBeGreaterThanOrEqual(-0.0001);
        expect(point.y).toBeGreaterThanOrEqual(-0.0001);
      }
    });
  });

  describe("thick paths", () => {
    it("makes one capsule per segment", () => {
      const path = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
      expect(thickenPath(path, 12)).toHaveLength(2);
      expect(thickenPath(path, 12, true)).toHaveLength(3);
    });

    it("keeps a bot out of a diagonal wall", () => {
      const wall = thickenPath([{ x: 0, y: 0 }, { x: 200, y: 200 }], 12);
      let position = { x: 100, y: 104 };
      for (const solid of wall) position = separateCircleFromSolid(position, 24, solid);
      for (const solid of wall) {
        expect(Math.sqrt(pointToSolidDistanceSquared(position, solid))).toBeGreaterThanOrEqual(23.99);
      }
    });

    it("outlines a path as a closed loop of both sides", () => {
      const outline = pathOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10);
      expect(outline).toHaveLength(4);
      // Both offsets sit half a thickness either side of the spine.
      expect(Math.min(...outline.map((p) => p.y))).toBeCloseTo(-5, 6);
      expect(Math.max(...outline.map((p) => p.y))).toBeCloseTo(5, 6);
    });
  });

  describe("insetting an outline", () => {
    const RECT = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];

    it("pulls a rectangle in by the same amount on every side", () => {
      expect(insetPolygon(RECT, 6)).toEqual([
        { x: 6, y: 6 }, { x: 94, y: 6 }, { x: 94, y: 54 }, { x: 6, y: 54 },
      ]);
    });

    it("does not care which way the outline was wound", () => {
      expect(insetPolygon([...RECT].reverse(), 6).map((p) => `${p.x},${p.y}`).sort())
        .toEqual(insetPolygon(RECT, 6).map((p) => `${p.x},${p.y}`).sort());
    });

    it("miters an angled corner so both edges move by the full distance", () => {
      // A 45° chamfer: the mitered vertex must sit further in than the offset
      // itself, or the two faces would not both land at the right depth.
      const chamfered = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 140, y: 40 }, { x: 140, y: 100 }, { x: 0, y: 100 }];
      const inset = insetPolygon(chamfered, 10);
      const edgeDepth = (a: Vec2, b: Vec2, original: Vec2, next: Vec2): number => {
        const dx = next.x - original.x;
        const dy = next.y - original.y;
        const length = Math.hypot(dx, dy);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return Math.abs((mid.x - original.x) * dy - (mid.y - original.y) * dx) / length;
      };
      for (let i = 0; i < chamfered.length; i += 1) {
        const next = (i + 1) % chamfered.length;
        expect(edgeDepth(inset[i], inset[next], chamfered[i], chamfered[next])).toBeCloseTo(10, 6);
      }
    });

    it("blunts a spike rather than sending its vertex to infinity", () => {
      const spike = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 1 }];
      for (const point of insetPolygon(spike, 5)) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(Math.hypot(point.x - 50, point.y - 0.5)).toBeLessThan(100);
      }
    });
  });
});
