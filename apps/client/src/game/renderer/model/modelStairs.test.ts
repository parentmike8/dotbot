import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import type { Rect, StairLink } from "@dotbot/game/types";
import { stairHalves } from "@dotbot/game/mapModel";
import { worldMap } from "@dotbot/game/content/world";
import { buildFloorModel } from "./modelFloor";
import { drawStair, drawStairHead } from "./modelStairs";
import { SHADOW_ALPHA, type ShadowPad } from "./tone";

/**
 * A roof stair is looked at from two places and has to be two different marks.
 *
 * From the street you see the roof OF the stairwell — a closed housing, which is what
 * `drawStairHead` draws and why it exists at all: calling the interior `drawStair`
 * here once left Downtown's towers with staircases lying open on top of them. Standing
 * on the deck you see INTO it, and the housing tells the opposite lie. Play reported
 * that one: "we can't see the stairs going down, it's just a white square, so it's not
 * obvious it's stairs when on that floor."
 *
 * The deck view is `drawStair`, the identical flight every interior floor draws. A
 * purpose-built roof version was tried first — a housing with its near wall removed —
 * and play rejected it twice over: the missing wall read as an exit ("it almost looks
 * like the doors are ways to get off the roof") and the white-to-black tread ramp is
 * already the familiar language for "down".
 *
 * WHAT THIS PINS, and what it does not. It pins that the two MARKS differ in the way
 * that matters — one shows a shaft, one does not — and that neither leaks outside the
 * stair's footprint. It does NOT pin the WIRING: which container `buildRoofArt` puts
 * each into, or the line in `GameRenderer` that toggles them. Swapping those is not
 * caught here. `mapArt` and `GameRenderer` both construct pixi Containers, so importing
 * either needs a DOM this suite does not have, and the honest options were a jsdom
 * environment for one assertion or saying so out loud.
 */

type Painted = { color: number; points: Rect[] };

/**
 * Enough of Pixi's Graphics to record filled geometry. `volume`, `inlay` and
 * `contact` all reach the canvas through `rect`/`poly` plus a `fill`, so batching by
 * paint call is the whole surface needed.
 */
class Recorder {
  readonly painted: Painted[] = [];
  private pending: Rect[] = [];
  private cursor: { x: number; y: number } | null = null;
  private path: Array<{ x: number; y: number }> = [];

  rect(x: number, y: number, w: number, h: number): this {
    this.pending.push({ x, y, w, h });
    return this;
  }

  roundRect(x: number, y: number, w: number, h: number): this {
    return this.rect(x, y, w, h);
  }

  poly(points: number[] | Array<{ x: number; y: number }>): this {
    const flat = typeof points[0] === "number"
      ? (points as number[])
      : (points as Array<{ x: number; y: number }>).flatMap((point) => [point.x, point.y]);
    this.bounds(flat);
    return this;
  }

  moveTo(x: number, y: number): this {
    this.cursor = { x, y };
    this.path = [{ x, y }];
    return this;
  }

  lineTo(x: number, y: number): this {
    this.cursor = { x, y };
    this.path.push({ x, y });
    return this;
  }

  circle(cx: number, cy: number, radius: number): this {
    return this.rect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  arc(cx: number, cy: number, radius: number): this {
    return this.circle(cx, cy, radius);
  }

  closePath(): this {
    return this;
  }

  beginPath(): this {
    return this;
  }

  stroke(style?: { color?: number }): this {
    return this.paint(style?.color ?? 0);
  }

  fill(style?: { color?: number } | number): this {
    const color = typeof style === "number" ? style : style?.color ?? 0;
    return this.paint(color);
  }

  private bounds(flat: number[]): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index + 1 < flat.length; index += 2) {
      minX = Math.min(minX, flat[index]);
      maxX = Math.max(maxX, flat[index]);
      minY = Math.min(minY, flat[index + 1]);
      maxY = Math.max(maxY, flat[index + 1]);
    }
    if (minX <= maxX) this.pending.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }

  private paint(color: number): this {
    if (this.path.length > 1) {
      this.bounds(this.path.flatMap((point) => [point.x, point.y]));
    }
    if (this.pending.length > 0) this.painted.push({ color, points: this.pending });
    this.pending = [];
    this.path = [];
    this.cursor = null;
    return this;
  }
}

const recorder = () => new Recorder() as unknown as Graphics & { painted: Painted[] };
const pad = (): ShadowPad => SHADOW_ALPHA.map(() => recorder());

/** The dark of an open shaft, from `drawStair`: the floor below, seen through a hole. */
const SHAFT = 0x23272b;

function stair(overrides: Partial<StairLink> = {}): StairLink {
  return {
    id: "s1",
    rect: { x: 200, y: 300, w: 64, h: 96 },
    toFloorId: "civic:F3",
    direction: "down",
    ...overrides,
  } as StairLink;
}

const STAIRS = [
  stair(),
  stair({ id: "s2", rect: { x: 200, y: 300, w: 96, h: 64 } }),
  stair({ id: "s3", direction: "up" }),
  stair({ id: "s4", rect: { x: 40, y: 40, w: 60, h: 60 } }),
];

describe("a roof stair, from the two places it is looked at", () => {
  it("opens a visible shaft from the deck and closes it from the street", () => {
    for (const link of STAIRS) {
      const head = recorder();
      drawStairHead(head, pad(), link);
      const flight = recorder();
      drawStair(flight, pad(), link);

      const shaftIn = (marks: Painted[]) => marks.filter((mark) => mark.color === SHAFT).length;
      // The housing is a solid box: nothing behind it is visible, so nothing in it is
      // painted the dark of the floor below.
      expect(shaftIn(head.painted), `head on ${link.id} should show no shaft`).toBe(0);
      // The well is the same box with its near wall gone, so the shaft shows.
      expect(shaftIn(flight.painted), `flight on ${link.id} should show a shaft`).toBeGreaterThan(0);
      // And the flight itself: treads are many small marks, which is what makes it
      // read as stairs rather than as a hole.
      expect(
        flight.painted.length,
        `flight on ${link.id} should draw more than the head does`,
      ).toBeGreaterThan(head.painted.length + 4);
    }
  });

  /**
   * The end you walk in at is the light end, whichever way the flight goes.
   *
   * This is the cue a player steers by, and it was inverted for every ascending flight in
   * the game. Value used to follow `bottom` — the flight's physical foot — while entry
   * follows `direction`, so with `bottom: "S"` a descent was entered at its light end and an
   * ascent at its dark one. Two stairs on one floor read opposite ways. Reported from play:
   * "it's still not obvious which end I go into. A couple times, I went in the wrong
   * direction because it wasn't clear."
   *
   * Asserted over BOTH directions and BOTH axes, because that is the matrix the bug lived
   * in: it was invisible on half the cases and wrong on the other half, and a test covering
   * one direction would have passed throughout.
   */
  it("paints the entry end light and the far end dark, up and down alike", () => {
    for (const link of STAIRS) {
      for (const direction of ["up", "down"] as const) {
        for (const bottom of ["N", "S", "E", "W"] as const) {
          const g = recorder();
          const turned = { ...link, direction, bottom } as StairLink;
          drawStair(g, pad(), turned);

          const { entry, exit, vertical } = stairHalves(turned);
          const centre = (half: Rect) => (vertical ? half.y + half.h / 2 : half.x + half.w / 2);
          const axis = (box: Rect) => (vertical ? box.y + box.h / 2 : box.x + box.w / 2);

          /**
           * Mean brightness of the treads nearest each half's centre.
           *
           * Treads only: the shaft fill, the stringers and the guard rails are all dark by
           * design and sit across the whole flight, so including them would swamp the ramp
           * this is measuring.
           */
          const luma = (of: Painted) => ((of.color >> 16 & 0xff) + (of.color >> 8 & 0xff) + (of.color & 0xff)) / 3;
          const near = (at: number) => {
            const marks = g.painted.filter((mark) => mark.color !== SHAFT
              && mark.points.every((box) => Math.abs(axis(box) - at) < 14));
            return marks.reduce((sum, mark) => sum + luma(mark), 0) / Math.max(1, marks.length);
          };

          const inAt = near(centre(entry));
          const outAt = near(centre(exit));
          expect(inAt, `${link.id} ${direction}/${bottom}: entry half should be lighter than exit half`)
            .toBeGreaterThan(outAt);
        }
      }
    }
  });

  it("keeps both marks inside the stair's own footprint", () => {
    // A mark that spills onto the deck is a mark the collider does not have. The
    // housing's own volume is allowed to rise — `volume` lifts its top face — so the
    // check is on the horizontal extent only.
    for (const link of STAIRS) {
      for (const [name, draw] of [["head", drawStairHead], ["flight", drawStair]] as const) {
        const g = recorder();
        draw(g, pad(), link);
        for (const mark of g.painted) {
          for (const box of mark.points) {
            expect(box.x, `${name} on ${link.id} spills west`).toBeGreaterThanOrEqual(link.rect.x - 0.01);
            expect(box.x + box.w, `${name} on ${link.id} spills east`)
              .toBeLessThanOrEqual(link.rect.x + link.rect.w + 0.01);
          }
        }
      }
    }
  });
});

/**
 * A wall that ends on a flight has to be DRAWN on it.
 *
 * Reported on sight: "the top barrier is not visible on the stairs in the observatory".
 * The barrier was in the data and in the collider the whole time — the observatory's F1 cap
 * is a capsule spanning y 2700..2708 and the flight it caps is y 2700..2820, so the cap sat
 * wholly inside the stair rect and the treads painted over every pixel of it. Its GROUND
 * twin was invisible for the same reason, and so was any wall anywhere that ends on a
 * flight.
 *
 * The fix is z-order, not geometry: the flight belongs with the slab and the paint, under
 * the structure built on top of them. This pins that, because the failure is silent — the
 * wall is still there, still solid, still stopping you, and only invisible.
 */
describe("a flight is floor, not furniture", () => {
  const observatory = worldMap.buildings.find((building) => building.id === "observatory")!;

  it("draws the stair layer inside architecture, under the walls", () => {
    for (const floor of observatory.floors) {
      const model = buildFloorModel(observatory, floor);
      // Inside `architecture`, not a sibling drawn after all of it.
      expect(model.stairs.parent, floor.id).toBe(model.architecture);
      expect(model.view.children, floor.id).not.toContain(model.stairs);
      // And with the structure still to come after it, which is what puts a wall on top.
      const at = model.architecture.children.indexOf(model.stairs);
      expect(at, floor.id).toBeGreaterThanOrEqual(0);
      expect(at, floor.id).toBeLessThan(model.architecture.children.length - 1);
    }
  });
});
