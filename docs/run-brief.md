# Run brief — unattended session, 2026-07-30

The working brief for the current long autonomous run. Referenced by the active `/goal`.
Read it in full before starting. It supplements, never replaces,
`docs/map-building-contract.md` — §4.1 and §8 of the contract are the process authority.

## What the previous run did, and what it cost

2026-07-29's run spent its whole window on task #77 and did not reach #74 or #79. That was
the brief working as written — #77 was listed first and called "the bulk of the run and the
priority", with "finish and commit each unit before starting the next" — and the estimate
of #77 was simply wrong. Nine Civic floors plus three legacy ledgers, where about eight of
the fixes broke something else and each needed a re-probe, a re-render and a re-test, is a
whole session.

**So the order is inverted this time. #74 and #79 come FIRST, and the rest of #77 is the
tail.** If the window runs out, it runs out on floors rather than on features.

Shipped last run, for context: Downtown's `FLOOR_QUALITY_BUDGET` is now empty for all four
buildings (it was 13 issues), `WRONG_SIDE_DEBT` is empty, 17 of 27 floors have been rendered
and judged, and two tools exist that did not before — `enclosure.probe.ts` and a fix that
made ROOF plans visible in the lab at all.

## Standing setup

- Node 20 for every command: `source ~/.nvm/nvm.sh && nvm use 20`.
- The Vite dev server is already up on **:5173**, the API on **:3001**. Reuse them. Do not
  start new servers; do not ask to.
- Renders come from `http://localhost:5173/?worlds&shots=1`, which writes every frame to
  `tmp/lab/map-<id>.png`. Per-floor frames are `tmp/lab/map-floor-<building>-<label>.png`
  (41 frames total: 14 region/overview + 27 floors).
- `pnpm --filter @dotbot/game exec tsx src/content/enclosure.probe.ts` reports, per floor
  across BOTH maps: connected components of standable floor, fixtures with no standable
  neighbour, and fixtures standing inside a wall. It renders no verdict — it points the eyes
  at coordinates.
- Push as `parentmike8` over https. Commit and push as you go — main is not live.

## Order of work

Finish and commit each unit before starting the next. If the run ends early, it ends at
the last complete unit. Never leave a half-done change in main.

### 1. Task #74 — ambient motion

Order within the task: carousel and waltzer turning → tree sway → movement trails → falling
leaves.

- Build geometry once and move containers. A transform per frame; never `g.clear()` and
  redraw. In Pixi 8 a `Graphics` *is* a `Container`, so `rotation`/`pivot`/`position` apply
  to it directly.
- Spawn only inside `visibleWorldBounds()`.
- Honour `reducedMotion`.
- Both rides are round, so their colliders are discs (`ROUND_KINDS` → capsule collapsed to a
  point). A turning glyph over a disc collider stays truthful, which is why the rides come
  first and anything rectangular does not turn.
- Verify by advancing the clock and shooting the same object at several phases. Ambient
  motion is the one thing that genuinely **can** be watched moving from the browser pane —
  synthetic key events never reach the game's handlers, but the clock does advance. So
  actually watch it move.
- `docs/world-motion.md` is the existing reference; keep it current.
- Memory `motion-is-wanted` is relevant: contract rule 4 bans frozen smoke, NOT animation.
  Never cite it to cut a moving subject.

### 2. Task #79 — trees

In this order, each committed before the next begins.

**(a) Height.** Trees ground at `LIFT.column + 4` = 15 (`modelGlyphs.ts` ~line 965) on a
scale where `LIFT.tower` is 34. That is why they read flat and show no parallax. Raise it
and check whether object parallax then reads. If it still doesn't, that is task #61 —
parallax has direction but no magnitude — and the right move is to **say so** rather than
keep raising numbers until something looks different.

**(b) Canopy art.** `foliageMass` (`modelGlyphs.ts:821`) literally scatters discs at one
value, which is exactly what it looks like. A canopy wants a silhouette plus interior
shading: an outer mass, a lit crown, a shaded underside, and a trunk that reads through it.
`treeTrunkRadius` in `mapModel.ts` is shared with the collider — the drawn trunk and the
thing that stops you are the same number, and must stay that way.

**(c) Asymmetric canopy concealment — last, and only if (a) and (b) are committed.**
Standing under a canopy conceals you from bots outside it; you keep full vision. This was
approved deliberately. It is a real combat change and it touches the same
server-authoritative sighting the AI uses (`visibility.ts`, `seesOutdoors`, consumed by
`simulation.ts`), where no object occludes sight at all today. Gate it behind tests and a
lab render. If it is not finished and green, **revert it rather than commit it** — a
half-wired visibility rule in main means the AI sights differently from the player.

### 3. Task #77 — the last ten floors

Ten floors have never been rendered and judged. Their audits are clean, and clean is not the
same as looked at — the previous run found a black-rendering roof, a cart inside a wall and a
cafe table in a fire exit on floors whose audits all passed.

| Floor | Probe findings to look at |
|---|---|
| lot6 GROUND, B1 | `lot6-fuel-a` (drum) at 190,1148 has no standable floor beside it. One island at 196,1156 is probably an exterior sliver. Lot 6 is the audited reference building — expect little, verify anyway. |
| temple GROUND, B1, B2, ROOF | Nothing outstanding from the probe. Four floors of dungeon nobody has composed twice. |
| roundhouse GROUND | Islands 1344 at 2663,1361 and 1152 at 2559,1393. |
| box GROUND, F1 | F1 islands 896 at 3104,538 and 960 at 3056,482. |
| pavilion GROUND | Nothing outstanding; F1 was done last run. |

Per floor, loop: render → **look at the image** → judge it as a designed space → change the
source → re-render → look again. What to judge:

- Does each piece of furniture relate to a wall, a window, a door or another piece — or does
  it float adrift in the middle of the slab?
- Is anything standing in a doorway's approach cone?
- Does a work surface face something?
- Is circulation a legible route, or just the gaps left over between objects?
- Walking in, can you tell what the room is *for*?
- Are repeated floors actually different rooms, or one plan restated N times?

One commit per building. Downtown's ledger in `packages/game/src/mapValidation.test.ts` is
now **empty for every building** — it may not grow. If a change would add an issue, the
change is wrong.

Also still open on beacon, below the audit's 1536 threshold and therefore unreported: small
standable islands inside the bathrooms and a kitchen corner on GROUND and F1 (960, 1152, 832,
384, 320, 64). Same shape as Mercy's WCs — fixtures crowding the entry. Worth a look while
nearby, not worth a detour.

## Process, non-negotiable

- **The eyes are the gate.** Contract §4.1 and §8: a floor that was edited and not looked at
  is not done. Where looking changed nothing, say that explicitly — it is a checkable claim,
  and claiming it falsely is the one failure that breaks the whole method.
- **In a tight room, change SIZE or COUNT, not position.** This is the previous run's main
  lesson and it cost eight or nine failed relocations. Every position in a full room is
  load-bearing for something; the free variables are how big a fixture is and how many the
  room holds. See memory `moving-a-fixture-breaks-something`.
- **Tests can reject a map; they cannot approve one.** Three placement metrics have now failed
  on real data — a dead-gap band (23% of all gaps), an entry-door shortfall (blind to a
  narrower door later in the route), and a reach check that flagged a sink inside its own
  worktop. Do not invent a fourth and trust it.
- Before trusting any new check, prove it **fails** on the broken state, then restore.
- A check that reasons about the wrong model cannot see the bug. `solid-overlap` compares
  object to object and never object to wall; `object-off-floor` asks about a floor's bounds,
  which a curved or chamfered shell is not; `disconnected-area` needs standable floor to
  strand, so a fixture out of reach in a connected room is invisible to it. When a check
  reports zero, first ask whether it was looking at anything.
- Fix the generator, not the instance. `wcFixtures` was one function and eighteen defects.
- **Never `git checkout <file>`** to undo an experiment. It reverts to HEAD and has already
  destroyed a session's work. Back up with `cp` first.
- Full gate before each commit: `pnpm -r typecheck`, then game + client + protocol + server +
  matchmaker test suites, then `world.audit.ts`. Watch for `No bot-clear blueprint spawn` and
  `bot ... is wedged` — those are module-load failures that take out a dozen test files at
  once and they are the usual cost of moving a fixture.
- Skip task #69 entirely (walk the world live). It needs a real browser and the game loop
  cannot be driven from here. Saying otherwise would be a false report.

## Report at the end

Four things, bluntly:

1. What changed, per floor or per feature.
2. What **looking** changed that no test would have caught.
3. Anything that could not be verified without a human at the keyboard.
4. Anything gotten wrong and corrected along the way.
