# One-room test: the lit model

Status: **completed historical vertical test.** The approved drawing language is
now the production `lit-model` renderer. The gaps below describe the test at the
time; they are not the active backlog. See [`backlog.md`](backlog.md).

## What was tested

Lot 6 Depot GROUND, rebuilt in a new drawing language with **no change to the map
data**. Same walls, same 21 objects, same coordinates, same colliders as the
shipped line plan. Only the renderer differs, so the comparison isolates the
drawing language from the authoring.

Open the lab at:

```bash
pnpm dev
```

- `/?lab` — the floor in the new language
- `/?lab&view=plan` — the same floor in the shipped language
- `/?lab&view=split&zoom=close&focus=racks` — side by side
- `/?lab&zoom=play` and a phone-sized window — legibility at play zoom
- `/?lab&floor=B1` — the cellar, same language, no extra machinery
- `/?lab&shots=1` — writes the whole comparison set to `tmp/lab/`

The lab has no ticker, no input and no simulation. It renders once at a fixed
camera so a language can be tuned and screenshotted repeatedly.

## Why the line plan failed

Not execution. [`style.ts:7`](../apps/client/src/game/renderer/style.ts) states
the rule directly:

> Nothing here casts shadows, blends gradients, or imitates materials; weight and
> value carry all meaning.

That is correct for an architectural drawing and fatal for a game. Drafting
notation exists to *abstract* an object: the CAD symbol for a parts rack really
is a rectangle with bars in it. The renderer was faithfully executing a spec that
banned the three tools — tone, cast light, material — that make a shape read as a
physical thing. No amount of further passes on line work could have fixed it.

## The three rules of the new language

1. **One light.** Everything is lit from the north, high enough that shadows stay
   short. Top faces lit, south faces in shade, contact shadows south-east. No
   object invents its own light.
2. **Silhouette == footprint == collider.** Apparent height is a south-edge band
   *inside* the authored rect, never an overhang. The plan-view promise — what you
   see is what blocks you — survives intact. Only shadow may fall outside a rect.
3. **Achromatic.** Neutral greys, with a ~4% warm/cool bias so steel and timber
   separate by material without reading as colour. The whole chromatic budget
   belongs to gameplay: bots, Dots, plates, extraction.

Kept from the old system: strict plan projection, colour reserved for gameplay,
code-drawn kits from map data, the floor-brief authoring discipline. Discarded:
the no-shadow rule, pure-white paper, detail-by-annotation, and line weight as
the *only* hierarchy.

## What the language derives rather than authors

None of this is placed by hand, so a new floor gets it for free and no one is
tempted to scatter marks to balance a composition:

| Feature | Derived from |
|---|---|
| Room floor finishes | Flood fill of the slab against walls *and* door gaps, then classified by the anchor furniture standing in each enclosure (`rooms.ts`) |
| Pick-aisle lane paint and bay ticks | The gap between parallel racking runs, and each rack's own bay pitch |
| Dock apron and keep-clear hazard hatching | Doorways wider than 96 units flagged `open` |
| Traffic polish and skid marks | The lanes those doors and aisles imply |
| High-bay light pools | A regular fixture grid per room — a real building system |
| Painted equipment outlines | The machines in shop and plant rooms |
| Roll-up curtain, slats, guide rails | The doorway's own width and its wall's thickness |

Delete a partition and its room finish merges away. Delete the dock doors and the
apron, hatching and spine go with them.

## Bot-native contents

Rack bays hold **cores, plates, boards and cartons** on pallets. Specific
contents buy more recognition per pixel than fidelity does, and they make the
world DotBot's instead of a borrowed human one. This is `dotbot-world-and-run-bible.md`
§10.3A, finally visible.

## Measurements

Taken in the lab on this machine (`window.labPerf`), median of repeated passes:

| Metric | Value |
|---|---|
| Build the whole floor's geometry | **1.9 ms** (once per floor) |
| Render a frame | **0.1 ms** (~0.6% of a 16.7 ms budget) |
| Display nodes for the floor | 54 |
| Runtime image assets | **0 bytes** |
| Code | 2 089 lines across 4 files |
| Lazy chunk in the production build | 34.2 kB (13.0 kB gzipped) |

For contrast, the sprite path ships a 200 kB curated atlas plus manifests, and
depends on 1.7 GB of licensed source packs, an atlas build script, attribution,
and a per-placement "does this asset share the projection?" check.

## Validation

- `pnpm --filter @dotbot/client typecheck` — clean
- `pnpm --filter @dotbot/client test` — 78 passed
- `pnpm --filter @dotbot/game test` — 166 passed
- `pnpm --filter @dotbot/server test` — 18 passed (one multiplayer extraction
  test is timing-flaky and fails intermittently; it is unrelated to this work and
  passes on re-run)
- `pnpm --filter @dotbot/client build` — clean

No map data, simulation, collision, netcode or existing renderer file was
changed. The three edits outside new files are the `lab` route
(`routing.ts`, `main.tsx`) and registering the dev-only shot plugin
(`vite.config.ts`).

## Why plan view is the right answer for a vertical world

`/?lab&floor=B1` renders the cellar in the same language with no additional
machinery: no foreground pass, no occlusion split, no alpha-masked fog copies.
Depth in a stair is a *value* change — treads darken as they drop — so a flight
reads as descending from directly overhead. The shipped 3/4 sprite path already
carries `foregroundFogGfx` with an alpha mask plus a per-sprite occlusion split
to make **one** floor work; every additional storey multiplies that. Plan view
does not have the problem to solve.

## Remaining gaps at the time of the test

Honest list. None of these are language problems:

- **The floor is under-authored.** The region between the third rack run and the
  stair core, and most of B1, read as unused. That is the map, not the renderer,
  and the new language makes it more obvious rather than less.
- **Two crates and a drum east of rack 3 have no operational relationship** to
  anything near them. Contract §4.1 would reject them.
- The kit covers the kinds on these two floors plus a generic fallback. Beds,
  medical, retail and residential kinds still fall through to `genericBox`.
- Not wired into `GameRenderer` or Map Studio. The lab is a parallel surface; the
  shipped line-plan renderer is untouched and still drives the game.
- No live movement or stair-traversal proof yet, so per contract §8 this is a
  vertical test rather than production-ready work.

## Progress since the one-room test

The room was approved, so the language is being taken through the whole game.

**Done and wired:**

- `visualTheme: "lit-model"` selects the language in the production renderer.
  `?theme=lit-model` overrides any map's authored theme for review.
- Interiors, authored ROOF plans and generated building roofs all share the
  roof/floor models, so a building looks the same from inside and from the street.
- The **exterior** is rebuilt: asphalt with a polished crown and gutters, kerbs
  with a real level change, ladder crossings, planting beds, extraction pads, and
  volumetric street furniture (tree, car, lamp, bench, planter, hydrant, bollard,
  bike rack, dumpster, kiosk, parking bays).
- **Dots and DotBots** are the game default, sharing `grounding.ts` with the lab
  so the approved look cannot drift between them.
- Lot 6's authoring bugs are fixed and the floor-quality audit now gates downtown.

**Rule added after review:** a moving thing may not be frozen into a static mark.
The review that produced it was of **static smoke** — a puff of circles over a
chimney, which read as a blob of debris rather than as smoke. Where animation is not
available, draw the part that genuinely does not move (the stack, the guard grille,
the grate). Recorded as rule 4 in `tone.ts`.

This is **not** a ban on motion, and the rule as written here was later misread that
way often enough to cost content. See `tone.ts` rule 4 and
`docs/world-motion.md` for the corrected statement: animation is wanted.

## Follow-ups recorded at the time

This list is retained to explain what the vertical test did not yet cover. It
has been superseded by production integration and is not an active TODO list.

- Object kinds still falling through to `genericBox`: beds, medical, residential
  seating and tables. Fourteen of them are the player base's, which is why the base
  is still drawn in the retired `plan` language.
- Downed DotBot state, and the in-run HUD and controls, still use the old language.
- A systematic sweep of the remaining surfaces: base/menu, lobby, manifest, mines,
  noise rings, impact feedback, fog.
- The §4.1 critique on Mercer Parts.
