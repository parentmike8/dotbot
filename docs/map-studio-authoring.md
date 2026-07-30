# Map Studio

Map Studio is a **tweak tool over authored map source**. It is deliberately not a
map editor.

The world is built in map source (`packages/game/src/content/*.ts`), by hand or by
an LLM, because that is what scales and what carries intent — a building's shell,
its rooms and its brief are all expressed as one `SourceBuilding` that the
compiler turns into runtime geometry. Studio exists for the edits that are faster
to make with a mouse than to describe: nudge that bench, delete that Dot, drop a
door in that wall.

Two decisions keep it small:

- **It renders through the production map art.** Every judgement is made against
  what a player actually sees. The editor it replaced drew its own schematic,
  which meant "does this aisle read as a route" was answered against a picture the
  game never shows.
- **It saves by patching the source file**, not by regenerating it, so the
  comments, helpers and named constants an author wrote all survive the round
  trip.

## Open and save

1. Start the client with `pnpm dev`.
2. Open `http://localhost:5173/?studio` (use the printed port if Vite chose
   another one). `?map=quayside` opens the non-rectangular reference building.
3. Pick an outdoor context or a building and floor. Outdoor contexts use the
   production streets, surfaces, buildings and code-drawn object renderer, not a
   schematic copy.
4. Pick a tool and make the edit.
5. Press **Save**. Each edited source file is patched in place.

Saving is **read-patch-write**: the file is fetched at save time and sent back as
the base, so a file an LLM changed while Studio was open is *refused* rather than
silently overwritten. Only buildings with a registered source file are editable;
the rest render but do not accept edits.

`/__studio/read` and `/__studio/write` are loopback-only Vite development
endpoints served by `apps/client/mapSourcePlugin.ts`. They are not part of the
shipped game server.

## Outdoor source ownership

Outdoor objects carry their source owner into the compiled map:

- An individually authored `obj.authored("stable-key", ...)` call is selectable,
  movable and resizable.
  Studio patches only that call's four geometry arguments. The ID expression,
  object kind, comments, options, rotation, facing, collision shape and other
  metadata remain untouched.
- A rhythm or other placing rule is wrapped in `obj.derived(...)`. Its emitted
  objects remain selectable for inspection, but cannot be dragged or resized.
  The inspector names the rule, source file, source expression, axis, bounds,
  spacing and gap list that an author must change. Studio never turns a rhythm
  into a literal object table.
- Insertion points, extraction pads and bot spawns expose their owning source and
  composition note for inspection. They are read-only because their runtime
  positions are presently assembled from semantic region fields rather than one
  safe literal patch target.

Direct outdoor patch locations use the authored key plus literal object kind as
a stable call fingerprint. The patch scanner ignores comments, strings and
templates, verifies that exactly one matching executable call still exists, and
then changes only its geometry arguments. Runtime IDs use the same authored key;
rule members derive theirs from the rule ID plus a stable member key, so inserting
or reordering unrelated placements does not renumber existing objects. A computed
runtime ID without this source locator is refused. As with buildings, Studio
refuses a save if the file changed on disk after the session loaded it.

## Tools

| Tool | What it does |
| --- | --- |
| `select` | Move and delete objects, Dots and openings. |
| `object` | Place a `MapObject` of the chosen kind. |
| `dot` | Place a Dot spawn of the chosen item. |
| `wall` | Draw a wall path — click each vertex, it compiles to a thickened run. |
| `opening` | Place a door, roll-up, archway or window by anchor on the nearest wall. |

Outdoor context currently supports `select` only. That is intentional: it is a
precision tool for existing individually authored objects, not a second outdoor
layout language.

Grid snapping is 0, 2, 4, 8 or 16 world units. Openings snap to the wall the
anchor lands nearest, matching `compileBuilding`'s `near` semantics — Studio never
computes arc length, and neither should an author. The standard person door is
derived from the full-size DotBot: diameter plus one 8-unit steering cell on each
side, currently 64 units clear. Wall thickness is additional geometry at the
jambs and never reduces that clear width.

## What the tool does not decide

Studio prevents format drift and makes geometry inspectable. It does not replace
spatial judgment. Before placing anything on a floor, write the purpose, zones,
operational sequence, adjacency, and intentional negative space required by
`docs/map-building-contract.md`. Read the composition with fresh eyes before
reaching for overlays.

## Required handoff check

Before calling a map production-ready:

1. Save with no errors reported.
2. Review every floor at fit and at play-relevant zoom.
3. Walk a full-size DotBot through every intended route in a real session.
4. Traverse every stair pair both ways without stopping or snagging.
5. Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.

The audits in §7 of the contract can reject a map; they cannot decide that its
layout is believable. Recorded debt stays debt until someone pays it — see the
ledger in `packages/game/src/mapValidation.test.ts`.
