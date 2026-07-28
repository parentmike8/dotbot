/**
 * The overlay's material, as a choosable theme.
 *
 * Four takes on glass were rendered side by side at `?skins` and B — the heavier
 * outline-free pane that floats in front of the world — was chosen to ship. The other
 * three are kept rather than deleted, because the intent is that a player will
 * eventually pick between them: "we should reserve the option for users to select from
 * a few different styles eventually."
 *
 * So this is a theme list and not a dev-only lab any more. Each id maps to a class that
 * carries the whole look as CSS custom properties, applied to the game shell — which is
 * why a picker later is a one-line change and not a restyle: set the class, done. Nothing
 * about the components knows a skin exists.
 *
 * Deliberately NOT built yet: the picker itself, and persistence. The standing direction
 * on the overlay is that nothing goes in it that is not necessary, so a style menu waits
 * until it is asked for rather than being added because the plumbing is ready.
 */

export type HudSkinId = "glass" | "deep" | "rim" | "accent";

export type HudSkin = {
  id: HudSkinId;
  /** Shown in a future picker. Plain words, no lore. */
  name: string;
  note: string;
};

export const HUD_SKINS: readonly HudSkin[] = [
  {
    id: "deep",
    name: "Deep",
    note: "A heavy pane with no outline, floating in front of the world. The default.",
  },
  {
    id: "glass",
    name: "Clear",
    note: "More of the world through the glass, with a hairline edge.",
  },
  {
    id: "rim",
    name: "Rimlit",
    note: "No outline; each pane catches the world's own north-west light on its top edge.",
  },
  {
    id: "accent",
    name: "Accent",
    note: "Clear, with colour on the parts that are live.",
  },
];

export const DEFAULT_HUD_SKIN: HudSkinId = "deep";

/**
 * The classes that carry a skin.
 *
 * Two of them: `hud-skin` holds everything the four share — which is most of it, since
 * they are all glass — and the variant class holds only what differs. Keeping the shared
 * half in one place is what stopped the four from drifting into four unrelated designs.
 */
export function hudSkinClass(id: HudSkinId = DEFAULT_HUD_SKIN): string {
  return `hud-skin hud-skin-${id}`;
}

/**
 * WHAT PROMOTING THIS OUT OF THE LAB COST, recorded because the next skin will cost it
 * again.
 *
 * The class goes on the game shell, so it reaches every surface inside the shell — not
 * only the corner panels. Most of them theme correctly for free because they are built
 * from the same variables: the quick-start card, the insertion card and the connection
 * banner are all `--panel-glass` plus `--hairline` plus `--ink`, so they simply became
 * dark panes with light text.
 *
 * The downed prompts did not, and they are the exact case #48 was raised for. They carry
 * NO background at all — deliberately, they are bare words over the world — and their ink
 * had been darkened specifically so they survived a pale floor. Inverting the ink put
 * light text straight back onto a near-white slab, which is the bug that was reported
 * from play. They get a pane under a skin, which is the same answer the run readout
 * needed and for the same reason: light ink cannot float.
 *
 * The rule to carry forward: a dark overlay may not leave ANY text unplated. The
 * plateless treatments in this stylesheet all silently depend on the ink being dark.
 */
export const SKIN_UNPLATED_WARNING =
  "A dark skin must plate every text surface: plateless text depends on dark ink.";
