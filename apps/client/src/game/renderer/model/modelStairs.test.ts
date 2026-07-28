import { describe, expect, it } from "vitest";
import type { Graphics } from "pixi.js";
import type { Rect, StairLink } from "@dotbot/game/types";
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
