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
});
