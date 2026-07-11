# M1-A Completion Report: Run reframe + identity palette

## Atomic implementation commits

- `582796d` — score removal and extraction rework
- `8644aa6` — run lifecycle and manifest
- `523c762` — free revive with one cracked plate
- `775cc35` — relationship palette

The parallel M1-B lane's commits were never staged from this lane. Its protocol, server, network-session, lobby, and `main.tsx` files remained outside M1-A ownership throughout.

## Part 1 — Score removal and extraction

- Removed `bankedDots`, `rivalBankedDots`, `dotsBanked`, and the simulation's banking-only `primarySquadId`.
- A completed non-ambient extraction now emits `extracted { botId, squadId, inventoryDots }` and removes that bot from subsequent snapshots.
- Ambient bots no longer select extraction as an AI target, and extraction resolution defensively ignores ambient bots.
- Removed the Bank/Rivals score blocks and their obsolete HUD styling.

## Parts 2–3 — Run lifecycle and manifest

- Added `GameConfig.runDurationMs`, defaulting to `480_000`.
- Changed the existing run clock to an eight-minute countdown while preserving its element and test-id contracts.
- The client hook ends the solo run on the player's `extracted` event, the player's `consumed` event, or the configured timeout. It clears movement/joystick input, rejects further Dash input, and continues snapshot rendering beneath the result overlay.
- The simulation respawn path now applies only to ambient bots; consumed non-ambient players remain consumed.
- Added the architectural-title-block Manifest overlay with outcome, KEPT, LOST, AI/player-bot kill totals, run time, and one `↻ NEW RUN` action using the existing remount mechanism.
- Quick-start copy now describes extraction rather than banking.

### Event flow: simulation → hook → manifest

1. `DotBotSimulation` emits `extracted` after an extraction channel or the existing `consumed` event after a consume channel.
2. `LocalSession.drainEvents()` returns the frame's events to `useDotBotGame`.
3. The hook appends drained events to its exposed cumulative event list. In the same frame it derives `RunResult`: extracted dots come from the `extracted` payload; death loss comes from the previous snapshot's player inventory; timeout loss comes from the current snapshot.
4. `App` classifies cumulative squad-attributed `consumed` events against static spawn metadata, splitting ambient victims into AI kills and non-ambient victims into player-bot kills.
5. `ManifestScreen` maps `extracted` / `died` / `timeout` to EXTRACTED / CONSUMED / RUN EXPIRED and renders the result plus kill totals.

## Part 4 — Free revive

- Removed the revive Dot cost and all AI/coverage gating that required a reviver to carry a Dot.
- Revives now construct one cracked plate and the remaining broken plates: `[0.5, 0, 0]` at the default plate count, with aggregate `shields = 0.5`.
- Reviver inventory is unchanged.

## Part 5 — Relationship palette

- All alive bot cores render in `INK.structure` black.
- Plates are the faction channel: viewer squad cyan `#15aabf`, ambient bots grey `#868e96`, and future non-ambient opposing squads red `#e03131`.
- Red opposing plates add the redundant second thin arc 3 px outside every intact plate.
- Cracked and broken plate strokes retain their state treatment in faction hue.
- Downed bots are hollow faction-colored rings.
- Capture, revive, consume, and extract progress rings use the channeler's faction hue relative to the viewer.
- HUD intact and cracked shield pips use squad cyan. Dot and map rendering is unchanged.

## Intentional test and assertion changes

Every changed assertion was intentional:

- Determinism digest: removed the deleted `bankedDots` and `rivalBankedDots` fields; entity/state digesting is unchanged.
- Ambient extraction test: replaced “AI rivals extract carried Dots” (`rivalBankedDots === 3`, inventory cleared) with 60 ticks asserting no ambient extraction coverage and the ambient bot retaining all three carried Dots.
- Player extraction test: replaced bank total/inventory-clear assertions with absence of the player from the resulting snapshot and an exact `extracted` event carrying two Dots.
- Two-minute soak: removed only the obsolete rival-extraction milestone and its expected value; movement, capture, combat, floor-change, finiteness, and bounds checks remain.
- Consumed-player lifecycle: replaced the old alive/full-shields/one-Dot respawn assertions with `state === "consumed"`, zero shields, and zero inventory.
- First revive case: renamed it to describe free cracked-plate behavior, changed starting reviver inventory from one to zero, changed revived shields from `1` to `0.5`, and added exact `[0.5, 0, 0]` segment coverage.
- Second revive case: added the `0.5` revived-shield assertion and changed expected reviver inventory from zero to the unchanged value of one.

The game package still has 58 tests; behavior coverage was replaced or strengthened rather than reducing the suite count.

## Verification

### Automated gates

- `pnpm typecheck` — passed across game, protocol, client, and server.
- `pnpm test` — passed: game 4 files / 58 tests, protocol 1 file / 2 tests, server 1 file / 1 test.
- `pnpm build` — passed for server TypeScript and the client Vite production build; 749 modules transformed. The existing large-chunk advisory remains non-failing.
- `git diff --check` — passed before the palette commit.

### Visible browser verification

- Countdown visibly advanced from `07:59` through later values.
- Squad bots rendered cyan plates around black cores; current ambient rivals rendered grey plates around black cores. A live combat encounter showed the player downed as a hollow cyan ring.
- Walking the player onto the depot extraction pad completed the channel and produced EXTRACTED with KEPT `1`, LOST `0`.
- A rival consume produced CONSUMED with KEPT `0`, LOST `1`.
- Clock expiry produced RUN EXPIRED with KEPT `0`, LOST `1`.
- `↻ NEW RUN` was exercised twice consecutively; each remount returned to Downtown, three shields, one carried Dot, and `07:59`.
- Map Studio opened through F3 and rendered its site plan, building/floor controls, and layer controls unchanged.
- Browser console errors: zero in the game and Map Studio.

To cover eight-minute expiry and deterministic combat/extraction without an eight-minute manual wait, the browser session temporarily changed only Vite's in-memory module objects (run duration, test movement/combat values, and test spawn positions). No source file was modified. All values and spawn overrides were restored in the browser, and a final fresh run confirmed the normal three-shield, one-Dot, `07:59` baseline before Map Studio verification.

## Exit criteria

1. Typecheck, tests, and build pass.
2. Countdown, all three manifests, KEPT/LOST values, two consecutive new runs, relationship colors, hollow downed rendering, and zero console errors were verified in the browser.
3. Map Studio is unaffected and was browser-verified.
4. The four requested implementation commits are atomic. This report is committed separately; final worktree status is clean.
