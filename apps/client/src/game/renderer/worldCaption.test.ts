import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INK } from "./style";
import { CAPTION, GROUND, captionBar, contrastRatio } from "./worldCaption";

/**
 * The map's text has to be readable on the map.
 *
 * This is the check behind a complaint that came back from play more than once — "the
 * text is unclear, poor contrast against the background" — and the reason it kept
 * coming back is that every caption's ink was chosen at its own call site against
 * whatever surface the author was looking at at the time. Two were unreadable and
 * three were fine, and nothing in the code could tell you which was which.
 */

describe("every caption clears its bar on every ground it lands on", () => {
  for (const [name, caption] of Object.entries(CAPTION)) {
    it(`${name} is readable everywhere it appears`, () => {
      const bar = captionBar(caption.size);
      for (const ground of caption.on) {
        const ratio = contrastRatio(caption.ink, GROUND[ground]);
        expect(
          ratio,
          `${name} (${caption.size}px) over ${ground}: ${ratio.toFixed(2)}, needs ${bar}`,
        ).toBeGreaterThanOrEqual(bar);
      }
    });
  }
});

describe("the two that were broken", () => {
  /**
   * Written as the failing measurement rather than as a comment, so the check would
   * have caught each of these the day it was introduced.
   */
  it("would still fail on the inks it replaced", () => {
    // The building name in the palette's quietest ink, seen from the street.
    expect(contrastRatio(INK.fixture, GROUND.asphalt)).toBeLessThan(captionBar(16));
    expect(contrastRatio(INK.fixture, GROUND.slab)).toBeLessThan(captionBar(16));
    // The stair tag in near-white, on the floor it actually sits on.
    expect(contrastRatio(0xf2f3f4, GROUND.polish)).toBeLessThan(captionBar(10));
    expect(contrastRatio(0xf2f3f4, GROUND.slab)).toBeLessThan(captionBar(10));
  });

  it("fixed each one with the quietest ink that passes, not the darkest available", () => {
    /**
     * The point of the table is legibility, not uniformity. A building name in
     * `INK.structure` would pass with room to spare and would also shout across the
     * whole footprint, which is the thing the original `fixture` choice was right about.
     * So both fixes take the lightest ink that clears their own bar, and this pins it by
     * showing that one step lighter — `INK.fixture` — does not.
     *
     * Passing is a floor, not a ceiling: `signTitle` and `interactionTag` are
     * deliberately darker than they need to be, because both sit above another line in
     * a hierarchy. Only the two repaired sites are pinned to the minimum.
     */
    const quieter = INK.fixture;
    expect(CAPTION.buildingName.ink).toBe(INK.anchor);
    expect(contrastRatio(quieter, GROUND.asphalt)).toBeLessThan(captionBar(CAPTION.buildingName.size));

    /**
     * The stair tag lands on `anchor` and not on the darker `opening` because its
     * declared grounds are indoor floors and roof decks — no asphalt. An ink chosen
     * against every ground in the world instead of this site's own would be a step
     * louder than the site needs, which is the mistake the table exists to prevent in
     * both directions.
     */
    expect(CAPTION.stairTag.ink).toBe(INK.anchor);
    for (const ground of CAPTION.stairTag.on) {
      expect(contrastRatio(quieter, GROUND[ground])).toBeLessThan(captionBar(CAPTION.stairTag.size));
    }
    expect(CAPTION.stairTag.on).not.toContain("asphalt");
  });
});

describe("the table is what the renderer actually draws", () => {
  /**
   * A declared table nothing reads is just a comment. Both files that put text in the
   * world are scanned for a label built from a bare colour instead of a `CAPTION` entry
   * — which is exactly how the six sites came to disagree in the first place.
   */
  const sources = ["mapArt.ts", "GameRenderer.ts"].map((file) => ({
    file,
    text: readFileSync(join(__dirname, file), "utf8"),
  }));

  it("has no world label built from a colour named at the call site", () => {
    /**
     * The check is about INK, not about the shape of the argument list.
     *
     * A first pass asserted that every call mentions `CAPTION`, which flagged both the
     * helper's own signature and its one-line forwarder — neither of which picks a
     * colour. Forwarding a caption through is fine. Naming a colour where the text is
     * built is the thing that produced a 1.60-contrast building name, so that is what
     * this looks for: a hex literal or an `INK.` member inside a label call.
     */
    for (const { file, text } of sources) {
      const calls = [...text.matchAll(/make(?:World)?Label\(([^;]*?)\)[;,\n]/g)].map((m) => m[1]);
      expect(calls.length, `${file} draws no world text at all — has the helper moved?`).toBeGreaterThan(0);
      const handPicked = calls.filter((args) => /0x[0-9a-fA-F]{6}|INK\./.test(args));
      expect(handPicked, `${file} names a colour where a label is built: ${handPicked.join(" | ")}`)
        .toEqual([]);
    }
  });

  it("uses every entry it declares", () => {
    // The other direction: an entry nothing draws is a rule about nothing, and it would
    // keep passing its contrast test forever while the real text drifted.
    const all = sources.map(({ text }) => text).join("\n");
    for (const name of Object.keys(CAPTION)) {
      expect(all, `CAPTION.${name} is declared and never drawn`).toContain(`CAPTION.${name}`);
    }
  });
});
