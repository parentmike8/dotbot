import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOT_COLOR, INK, RIVAL_RED, SQUAD_CYAN } from "./style";

/**
 * One colour, one spelling.
 *
 * The squad colour has to exist twice — once as a number for pixi, once as a CSS custom
 * property for the overlay chips — and there is no build step that shares them. So it is
 * asserted instead. A squad ring and a squad chip drifting to slightly different cyans
 * is the kind of thing nobody notices until a screenshot puts them side by side.
 *
 * This reads the stylesheet as text on purpose. The alternative was a comment asking the
 * next person to remember, which is not a mechanism.
 */

const css = readFileSync(join(__dirname, "../../ui/styles.css"), "utf8");

/** The value of a `--custom-property` in the stylesheet's root block. */
function cssVar(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`stylesheet has no --${name}`);
  return match[1].trim();
}

const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;

describe("the palette has one spelling per colour", () => {
  it("keeps --squad-cyan and SQUAD_CYAN identical", () => {
    expect(cssVar("squad-cyan").toLowerCase()).toBe(hex(SQUAD_CYAN));
  });

  it("keeps allegiance colours out of the ink ramp", () => {
    /**
     * The lit model is achromatic by rule — one light, neutral greys — and allegiance is
     * the deliberate exception. This pins the gap between the two, so a chromatic value
     * cannot be quietly adopted as an ink.
     *
     * The bound is measured, not chosen. `INK` is not literally neutral: it carries a
     * slight cool cast on purpose, widest at `INK.fixture` (0x7d838a) with 13 points
     * between its channels. A first pass asserted 8 and failed on the palette rather
     * than on a bug — the palette was right. 20 sits above every real ink with room to
     * spare, and an order of magnitude below cyan (170) and red (175), so the two
     * families cannot be confused for one another by accident.
     */
    const spread = (value: number) => {
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    const inks = Object.values(INK);
    expect(inks).not.toContain(SQUAD_CYAN);
    expect(inks).not.toContain(RIVAL_RED);
    for (const value of inks) {
      expect(spread(value), `INK ${hex(value)} has a colour cast`).toBeLessThanOrEqual(20);
    }
    for (const value of [SQUAD_CYAN, RIVAL_RED]) {
      expect(spread(value), `allegiance colour ${hex(value)} is not saturated`).toBeGreaterThanOrEqual(100);
    }
  });

  it("keeps the stylesheet's item marks on the same colours as the Dots", () => {
    /**
     * A bay button, a loot slot, a legend mark and the Dot they all refer to are the same
     * item. They were six separate literals in the stylesheet; now they are three custom
     * properties, and these are what stop those drifting from `DOT_COLOR`.
     */
    expect(cssVar("item-powerup").toLowerCase()).toBe(hex(DOT_COLOR.powerup));
    expect(cssVar("item-blueprint").toLowerCase()).toBe(hex(DOT_COLOR.blueprint));
    expect(cssVar("item-interaction").toLowerCase()).toBe(hex(DOT_COLOR.interaction));
  });

  it("gives the two chromatic Dot colours to the two chromatic item kinds", () => {
    // `GameRenderer` draws the intel mark and the radar ping in these, by name rather
    // than by literal — they used to be retyped at both draw sites, which is two more
    // copies of a palette value that can drift.
    expect(DOT_COLOR.powerup).not.toBe(DOT_COLOR.blueprint);
    expect(DOT_COLOR.interaction).toBe(INK.hairline);
  });
});
