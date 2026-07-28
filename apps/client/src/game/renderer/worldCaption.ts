import { INK } from "./style";
import { V, MAT } from "./model/tone";

/**
 * Every piece of text the world draws, and the ground each one lands on.
 *
 * Play kept reporting that the map's text was hard to read, and the reason it kept
 * happening is that each caption's ink was picked by eye at its own call site, against
 * whatever surface the author happened to be looking at. Two of them were unreadable:
 *
 * - The BUILDING NAME, the largest text on the map, in `INK.fixture` — 1.60 against
 *   asphalt, 2.84 against a floor slab. Effectively invisible from outside.
 * - The STAIR TAG, in near-white, at 1.06 against a polished floor. It was picked to
 *   sit on the dark stair plate, but `placeStairTag` puts it four or five units
 *   *outside* the stair rect, so it always lands on the landing floor instead.
 *
 * Three others measured fine, which is the other half of why this is a table rather
 * than a repaint: sign titles, sign details and extraction names all clear their bar
 * comfortably, and darkening them would have been change for its own sake.
 *
 * So a caption declares where it can land, and `worldCaption.test.ts` computes the
 * contrast for every pairing. Picking an ink by eye is no longer possible without the
 * check disagreeing.
 */

/** WCAG relative luminance of a packed RGB integer. */
function luminance(color: number): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((color >> 16) & 0xff)
    + 0.7152 * channel((color >> 8) & 0xff)
    + 0.0722 * channel(color & 0xff);
}

/** Contrast ratio between two packed RGB integers, 1 to 21. */
export function contrastRatio(a: number, b: number): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The surfaces world text can end up over.
 *
 * Not every tone in the palette — only the ones something is written on. A caption over
 * a wall cap or a shadow is a placement bug, not a contrast question.
 */
export const GROUND = {
  slab: V.slab,
  polish: V.polish,
  plantFloor: V.plantFloor,
  shopFloor: V.shopFloor,
  glass: V.glass,
  roofSteel: MAT.steelLit.top,
  /** The street. The darkest thing anything is written on, and where both failures were. */
  asphalt: 0xa4a8ad,
  footway: 0xd6dade,
  /** The interaction tag's own plate, which is why that one has never been a problem. */
  plate: INK.plate,
} as const;

export type GroundName = keyof typeof GROUND;

/**
 * The bar a caption has to clear.
 *
 * 3.0 for 14px and up, 4.5 below it — the standard split, and it matters here because
 * the building name is large enough to earn the lower bar while a 10px stair tag is
 * not. World units are not CSS pixels, but the camera renders roughly one to one at
 * play zoom, so the sizes are comparable and the split lands in the right place.
 */
export function captionBar(size: number): number {
  return size >= 14 ? 3.0 : 4.5;
}

export type Caption = {
  /** Font size in world units. */
  size: number;
  tracking: number;
  weight: string;
  ink: number;
  /** Every ground this text can be drawn over. The check tests all of them. */
  on: readonly GroundName[];
};

export const CAPTION: Record<string, Caption> = {
  /**
   * A building's own name, across the middle of its footprint.
   *
   * Was `INK.fixture`, the palette's quietest ink, on the reasoning that a name should
   * not shout. It went too far: from the street you could not read it at all. `anchor`
   * is the lightest ink that clears the bar on every ground it lands on — worst case
   * 4.25 over asphalt — so it is still a quiet label and it is now a legible one.
   */
  buildingName: { size: 16, tracking: 3.5, weight: "800", ink: INK.anchor, on: ["roofSteel", "slab", "polish", "asphalt", "glass"] },

  /** An extraction pad's name, on the ground just below the pad. */
  extractionName: { size: 11, tracking: 3, weight: "700", ink: INK.opening, on: ["asphalt", "footway", "slab"] },

  /**
   * UP or DN beside a stair.
   *
   * Was near-white, which reads beautifully on the stair's dark plate and is invisible
   * on the floor — and the floor is where `placeStairTag` puts it, four or five units
   * clear of the rect so it does not sit on the treads it is labelling.
   *
   * `anchor` rather than the darker `opening` because a stair is only ever indoors or on
   * a roof: its grounds do not include asphalt, so the bar is easier to clear here than
   * anywhere on the street. Choosing the ink against the whole palette of grounds rather
   * than this site's own would have made it a step louder than it needs to be.
   */
  stairTag: { size: 10, tracking: 2, weight: "700", ink: INK.anchor, on: ["slab", "polish", "plantFloor", "shopFloor", "roofSteel"] },

  /**
   * What a sign says, on the footway the sign faces.
   *
   * The title is deliberately a step darker than the quietest ink that would pass: the
   * two lines are a hierarchy, and the detail below it is already at `opening`. Passing
   * the bar is a floor, not an instruction to sit on it.
   */
  signTitle: { size: 13, tracking: 3, weight: "800", ink: INK.structure, on: ["footway", "asphalt", "slab"] },
  signDetail: { size: 10, tracking: 2.4, weight: "700", ink: INK.opening, on: ["footway", "asphalt", "slab"] },

  /**
   * An interaction tag, which carries its own plate — the pattern the rest now match.
   * Darker than it strictly needs for the same reason as the sign title: it is a prompt
   * to act on, and it is the loudest text the world draws.
   */
  interactionTag: { size: 9, tracking: 1.4, weight: "800", ink: INK.structure, on: ["plate"] },
};
