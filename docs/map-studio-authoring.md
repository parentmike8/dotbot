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
3. Pick a building and floor, pick a tool, make the edit.
4. Press **Save**. Each edited building's source file is patched in place.

Saving is **read-patch-write**: the file is fetched at save time and sent back as
the base, so a file an LLM changed while Studio was open is *refused* rather than
silently overwritten. Only buildings with a registered source file are editable;
the rest render but do not accept edits.

`/__studio/read` and `/__studio/write` are loopback-only Vite development
endpoints served by `apps/client/mapSourcePlugin.ts`. They are not part of the
shipped game server.

## Tools

| Tool | What it does |
| --- | --- |
| `select` | Move and delete objects, Dots and openings. |
| `object` | Place a `MapObject` of the chosen kind. |
| `dot` | Place a Dot spawn of the chosen item. |
| `wall` | Draw a wall path — click each vertex, it compiles to a thickened run. |
| `opening` | Place a door, roll-up, archway or window by anchor on the nearest wall. |

Grid snapping is 0, 2, 4, 8 or 16 world units. Openings snap to the wall the
anchor lands nearest, matching `compileBuilding`'s `near` semantics — Studio never
computes arc length, and neither should an author.

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
