# Run brief — unattended session, 2026-07-29

The working brief for the current long autonomous run. Referenced by the active `/goal`.
Read it in full before starting. It supplements, never replaces,
`docs/map-building-contract.md` — §4.1 and §8 of the contract are the process authority.

## Standing setup

- Node 20 for every command: `source ~/.nvm/nvm.sh && nvm use 20`.
- The Vite dev server is already up on **:5173**, the API on **:3001**. Reuse them. Do not
  start new servers; do not ask to.
- Renders come from `http://localhost:5173/?worlds&shots=1`, which writes every frame to
  `tmp/lab/map-<id>.png`. Per-floor frames are `tmp/lab/map-floor-<building>-<label>.png`
  (41 frames total: 14 region/overview + 27 floors).
- Push as `parentmike8` over https. Commit and push as you go — main is not live.

## Order of work

Finish and commit each unit before starting the next. If the run ends early, it ends at
the last complete unit. Never leave a half-done change in main.

### 1. Task #77 — room-quality pass, all 27 floors

The bulk of the run and the priority. Includes Mercy, Civic, Beacon and Lot 6, which live
in the Downtown regression map — so expect to update tests.

Per floor, loop: render → **look at the image** → judge it as a designed space → change
the source → re-render → look again. Repeat until it reads as somewhere a person decided
on. What to judge:

- Does each piece of furniture relate to a wall, a window, a door or another piece — or
  does it float adrift in the middle of the slab?
- Is anything standing in a doorway's approach cone?
- Does a work surface face something? A desk facing a blank wall 40 units away is a
  placement, not a decision.
- Is circulation a legible route, or just the gaps left over between objects?
- Walking in, can you tell what the room is *for*?
- Are repeated floors actually different rooms, or one plan restated N times?

**One commit per building.** The point is that any building's pass can be dropped without
unpicking the rest.

The recorded audit ledger lives in `packages/game/src/mapValidation.test.ts` (13 budgeted
issues: civic `false-aisle` ×6 + `solid-overlap` ×1, beacon `false-aisle` ×5, mercy ×1).
**The ledger may only shrink.** If a change would grow it, the change is wrong — fix the
cause instead of raising the budget.

Civic's nine floors carry identical booths on every floor and adrift furniture in the
lobby. That building needs the most real attention; budget for it.

While in Mercy, close **task #76**: the stair core has one opening and needs two, or a
turned flight. It is recorded as `WRONG_SIDE_DEBT` with a test asserting the broken state
holds in both directions — rewrite that test to assert the fixed state.

### 2. Task #74 — ambient motion

Order: carousel and waltzer turning → tree sway → movement trails → falling leaves.

- Build geometry once and move containers. A transform per frame; never `g.clear()` and
  redraw. In Pixi 8 a `Graphics` *is* a `Container`, so `rotation`/`pivot`/`position`
  apply to it directly.
- Spawn only inside `visibleWorldBounds()`.
- Honour `reducedMotion`.
- Both rides are round, so their colliders are discs (`ROUND_KINDS` → capsule collapsed
  to a point). A turning glyph over a disc collider stays truthful, which is why the
  rides come first and anything rectangular does not turn.
- Verify by advancing the clock and shooting the same object at several phases. Ambient
  motion is the one thing that genuinely **can** be watched moving from the browser pane
  — synthetic key events never reach the game's handlers, but the clock does advance. So
  actually watch it move.
- `docs/world-motion.md` is the existing reference; keep it current.

### 3. Task #79 — trees

In this order, each committed before the next begins.

**(a) Height.** Trees ground at `LIFT.column + 4` = 15 (`modelGlyphs.ts` ~line 965) on a
scale where `LIFT.tower` is 34. That is why they read flat and show no parallax. Raise it
and check whether object parallax then reads. If it still doesn't, that is task #61 —
parallax has direction but no magnitude — and the right move is to **say so** rather than
keep raising numbers until something looks different.

**(b) Canopy art.** `foliageMass` (`modelGlyphs.ts:821`) literally scatters discs at one
value, which is exactly what it looks like. A canopy wants a silhouette plus interior
shading: an outer mass, a lit crown, a shaded underside, and a trunk that reads through
it. `treeTrunkRadius` in `mapModel.ts` is shared with the collider — the drawn trunk and
the thing that stops you are the same number, and must stay that way.

**(c) Asymmetric canopy concealment — last, and only if (a) and (b) are committed.**
Standing under a canopy conceals you from bots outside it; you keep full vision. This was
approved deliberately. It is a real combat change and it touches the same
server-authoritative sighting the AI uses (`visibility.ts`, `seesOutdoors`, consumed by
`simulation.ts`), where no object occludes sight at all today. Gate it behind tests and a
lab render. If it is not finished and green, **revert it rather than commit it** — a
half-wired visibility rule in main means the AI sights differently from the player.

## Process, non-negotiable

- **The eyes are the gate.** Contract §4.1 and §8: a floor that was edited and not looked
  at is not done. Where looking changed nothing, say that explicitly — it is a checkable
  claim, and claiming it falsely is the one failure that breaks the whole method.
- **Tests can reject a map; they cannot approve one.** Two placement metrics have already
  failed on real data this week (dead-gap band: 23% of all gaps, mostly beds near walls;
  entry-door shortfall: blind to a narrower door later in the route). Do not invent a
  third and trust it.
- Before trusting any new check, prove it **fails** on the broken state, then restore.
- A check that reasons about the wrong model cannot see the bug. This has bitten
  repeatedly: bounding box vs plan, building vs floor, geometry vs traversal,
  `floor.walls` (empty on all 27 floors) vs `barriers`, clearance vs reachability, glyph
  vs collider. When a check reports zero, first ask whether it was looking at anything.
- Fix the generator, not the instance. If a bad placement came out of a blueprint or a
  derived layout, the blueprint is the bug.
- **Never `git checkout <file>`** to undo an experiment. It reverts to HEAD and has
  already destroyed a session's work. Back up with `cp` first.
- Full gate before each commit: `pnpm -r typecheck`, then game + client + protocol +
  server + matchmaker test suites, then `world.audit.ts` clean on the five newer
  buildings.
- Skip task #69 entirely (walk the world live). It needs a real browser and the game loop
  cannot be driven from here. Saying otherwise would be a false report.

## Report at the end

Four things, bluntly:

1. What changed, per floor.
2. What **looking** changed that no test would have caught.
3. Anything that could not be verified without a human at the keyboard.
4. Anything gotten wrong and corrected along the way.
