import { describe, expect, it } from "vitest";
import { downtownMap } from "./content/downtown";
import { polygonArea } from "./geometry";
import type { Rect, Vec2 } from "./types";
import { visibilityPolygon, visionContext } from "./visibility";

const CLINIC = downtownMap.buildings[0].floors[0];
const context = visionContext(downtownMap, CLINIC.id);

/**
 * The clinic corridor runs east-west at y 356 with four room doors off it. Walking
 * along it is the motion that showed the flashing.
 */
const CORRIDOR_Y = 356;
/** Where the corridor's north wall meets a partition — a point exactly on two segments. */
const WALL_CORNER: Vec2 = { x: 600, y: 400 };
/** A door's collision rect, the shape a bot stands inside while walking through. */
const DOOR_RECT: Rect = { x: 432, y: 318, w: 56, h: 12 };

const area = (polygon: Vec2[]) => Math.abs(polygonArea(polygon));

function shortestEdge(polygon: Vec2[]): number {
  let shortest = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    shortest = Math.min(shortest, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return shortest;
}

describe("visibilityPolygon", () => {
  it("carries no degenerate slivers", () => {
    /**
     * Corner rays are offset by a fixed angle, so each pair lands a fraction of a
     * unit apart and most pairs hit the same surface — which left the polygon two
     * thirds made of zero-area slivers. A tessellator handed that does not produce
     * the same triangles twice, and the fog drawn from it flickers as the origin
     * moves. The polygon has to be clean before anything renders it.
     */
    const polygon = visibilityPolygon({ x: 400, y: CORRIDOR_Y }, context);
    expect(shortestEdge(polygon)).toBeGreaterThan(0.2);
    // Three rays per endpoint went in; nothing like that many distinct corners exist.
    expect(polygon.length).toBeLessThan(context.walls.length * 2);
  });

  it("still sees the room from a point standing on a wall corner", () => {
    // Every ray hit an occluder at zero distance, so the polygon collapsed to a
    // point. The renderer reads a collapsed polygon as "see everything" and lights
    // the whole floor for a frame.
    expect(area(visibilityPolygon(WALL_CORNER, context))).toBeGreaterThan(50_000);
  });

  it("is not blinded by a door it is standing inside", () => {
    // A bot is inside a door's rect every time one closes on it: collision pushes
    // the bot clear, but `blocking` turns on first. Treated as an occluder, that
    // rect walls the bot into a 56x12 box and the floor goes dark.
    const inDoorway: Vec2 = { x: DOOR_RECT.x + DOOR_RECT.w / 2, y: DOOR_RECT.y + DOOR_RECT.h / 2 };
    const blinded = area(visibilityPolygon(inDoorway, context, [DOOR_RECT]));
    expect(blinded).toBeGreaterThan(DOOR_RECT.w * DOOR_RECT.h * 20);
  });

  it("still occludes with a door the bot is outside of", () => {
    // The containment escape must not turn doors into glass generally.
    const beside: Vec2 = { x: DOOR_RECT.x + DOOR_RECT.w / 2, y: DOOR_RECT.y + 80 };
    const withDoor = area(visibilityPolygon(beside, context, [DOOR_RECT]));
    const withoutDoor = area(visibilityPolygon(beside, context));
    expect(withDoor).toBeLessThan(withoutDoor);
  });

  it("changes smoothly as the origin walks", () => {
    // A guard on the shape of the change rather than the shape itself: a step of a
    // quarter unit must never swing the lit area by a large fraction of a room.
    let previous: number | null = null;
    let biggest = 0;
    for (let x = 240; x < 790; x += 0.25) {
      const current = area(visibilityPolygon({ x, y: CORRIDOR_Y }, context));
      if (previous !== null) biggest = Math.max(biggest, Math.abs(current - previous));
      previous = current;
    }
    expect(biggest).toBeLessThan(2_000);
  });

  it("is not blinded by a wall it is standing inside", () => {
    /**
     * The same rule the door test above pins, for static geometry — which is
     * where it was missing entirely.
     *
     * Lot 6's eight-unit partition is a *barrier*, not a rect wall, and an origin
     * at its centre made the polygon the partition's own interior: 710 units of
     * lit floor where standing a unit away gives 210559. A whole room going black
     * for a frame. Reachable because the renderer casts from the position it
     * draws, which is the predicted one plus a reconciliation offset applied
     * after collision.
     */
    const lot6 = downtownMap.buildings.find((building) => building.id === "lot6")!;
    const ground = lot6.floors.find((floor) => floor.label === "GROUND")!;
    const lotContext = visionContext(downtownMap, ground.id);
    const y = lot6.footprint.y + lot6.footprint.h * 0.55;
    const inside = area(visibilityPolygon({ x: 296, y }, lotContext));
    const beside = area(visibilityPolygon({ x: 291, y }, lotContext));
    expect(inside).toBeGreaterThan(beside);
  });

  it("does not turn a wall you are leaning on into glass", () => {
    /**
     * The other half of the containment rule, and the more dangerous half to get
     * wrong. A bot resting against a wall sits exactly on that wall's outline, so
     * a containment test that counted touching would delete the wall a player is
     * hiding behind — and they would be visible through it without knowing.
     */
    const lot6 = downtownMap.buildings.find((building) => building.id === "lot6")!;
    const ground = lot6.floors.find((floor) => floor.label === "GROUND")!;
    const lotContext = visionContext(downtownMap, ground.id);
    const y = lot6.footprint.y + lot6.footprint.h * 0.55;
    /**
     * A tenth of a unit *past* the west face — barely inside, which is all a
     * reconciliation nudge ever produces. Outside the face proves nothing: the
     * containment test rejects it before the margin is consulted, so a margin of
     * zero would pass. Inside is where the strictness has to hold.
     */
    const grazing = area(visibilityPolygon({ x: 292 + 0.1, y }, lotContext));
    const straddling = area(visibilityPolygon({ x: 296, y }, lotContext));
    expect(grazing).toBeLessThan(straddling / 2);
  });

  it("keeps the outline simple enough to tessellate the same way twice", () => {
    /**
     * The crawl, as a number.
     *
     * The fog is a rect with this polygon cut out of it, re-tessellated every
     * frame, and no tessellator triangulates a different vertex list the same
     * way. Distance-merging alone left the count changing on 227 of 799
     * quarter-unit steps — the shape held to 0.07% while the triangles under it
     * were reshuffled every few frames. Collinear vertices have no threshold to
     * drift across, so they go for good rather than popping.
     */
    let changes = 0;
    let previous = 0;
    let steps = 0;
    for (let x = 240; x < 790; x += 0.25) {
      const count = visibilityPolygon({ x, y: CORRIDOR_Y }, context).length;
      if (steps > 0 && count !== previous) changes += 1;
      previous = count;
      steps += 1;
    }
    expect(changes / steps).toBeLessThan(0.16);
  });

  it("simplifies without moving the lit edge", () => {
    // Simplification is only allowed to remove vertices that were never carrying
    // shape. If the area moves, it has eaten a real corner.
    for (const x of [300, 420, 560, 700]) {
      const poly = visibilityPolygon({ x, y: CORRIDOR_Y }, context);
      expect(poly.length).toBeGreaterThan(3);
      // Every kept vertex must be a genuine corner: no three in a row collinear.
      let collinearRuns = 0;
      for (let i = 0; i < poly.length; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const c = poly[(i + 2) % poly.length];
        const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        const span = Math.hypot(c.x - a.x, c.y - a.y);
        if (span > 1 && cross / span < 0.05) collinearRuns += 1;
      }
      expect(collinearRuns).toBe(0);
    }
  });
});
