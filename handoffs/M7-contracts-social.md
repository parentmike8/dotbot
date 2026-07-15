# Handoff M7: Contracts, insertion, squad social — matchmaking v2

**Agent brief.** M6 closed the solo economy loop; M7 makes the game social and directed. Four pieces, in implementation order: squad formation in the lobby, the downed-interaction verb set + all-squads pleas, insertion points with preference-weighted assignment, and planning-table contracts. Design authority: roadmap M7 (spec §10–§11) + owner rulings embedded below. Single lane, whole repo, phases in the order written — each phase leaves the suite green.

**Preconditions:** M6 complete and audited (`handoffs/M6-REPORT.md` + audit commits; check `git log`). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432** (never touch `covet-postgres` on 5432). Browser checks need visible windows.

## 1) Squad formation in the lobby (social v1)

- Room lobby becomes squad-aware: the three squads render as columns; players click to join/switch squads (cap 3 per squad) until host-start locks them. Late joiners join the emptiest squad by default.
- **Invites v1 are diegetic-minimal**: share the room code (exists) — no friends list, no accounts beyond device tokens. A `COPY INVITE` button per squad copies `<url>/#/r/CODE?squad=alpha`; the hash pre-selects that squad on join (still switchable until start).
- AI backfill unchanged (fills squads to 2). The lobby shows which slots will be AI at start.

## 2) Downed-interaction verbs + all-squads pleas (sim + protocol)

- **Verb set over a downed HOSTILE bot** (spec §8; squadmate revive unchanged):
  - `consume` — existing: eliminate + loot everything (overflow spills as ground dots).
  - `reviveClean` — revive the enemy, NO loot; they stand with the one-cracked-plate invariant. (Mercy/recruiting dynamics come later; the verb ships now.)
  - `lootThenRevive` — take everything carried, THEN revive them (cracked plate). Longer channel than either primitive.
  - All three are stationary noisy channels with separate `GameConfig` duration knobs (suggest consume 3000ms as-is, reviveClean 2500ms, lootThenRevive 4500ms — tuning knobs, not constants in logic).
  - Client: standing over a downed hostile shows a 3-verb context strip (keys and tap targets); the active channel renders with the existing ring + a verb label.
- **Pleas ping ALL squads** (owner ruling): a downed player may fire a plea (button/key) at most once per `pleaCooldownMs` (default 10s). Every client in the match — all squads, any floor — renders a fading distress ring at the plea position in the downed bot's relationship hue. Pleas ride SimEvents and BYPASS the interest filter on purpose: they are global intel (bait included). Squadmates additionally get a persistent edge-of-screen arrow while a squadmate is down (existing revive ping upgraded).
- Grey (ambient) invariants hold: never loot, never consume, never revive, never plea.

## 3) Insertion points + preferences + assignment (matchmaking v2)

- **Map data**: `MapDocument.insertionPoints: Array<{ id, name, position, floorId? }>` — Downtown gets ~6, spread across the sheet edges/quadrants (author them to the clearance rules; validation asserts every point spawns a full squad without overlap and `insertionPoints.length >= squads + 2`). The current three hardcoded squad anchors in Room.ts are RETIRED in favor of this data.
- **Preference, not pick** (spec §11): at the base **planning table**, a player registers an insertion preference — a mini-map (reuse the shell-preview SVG pattern, drawn from map data) with the insertion points marked; click to prefer, click again to clear. Persisted per player (`players.insertion_pref`, nullable text + migration). Shown as `INSERTION: NE PARK` in the panel.
- **Assignment at match start**, in Room.ts, pluggable function in `packages/game` (pure, unit-testable):
  1. Squad preference = the most common registered preference among members (tie → earliest joiner's).
  2. Enumerate assignments (points ≥ squads, N small — brute force is fine; document the scale ceiling).
  3. **Hard rule above all preferences: minimum pairwise squad spacing** (`minInsertionSpacing`, default ~900px). Assignments violating it are discarded even if preferences all match.
  4. Among valid assignments, maximize preference hits with ~80% weighting — i.e. score = hits + small deterministic jitter (seeded from matchId) so preferences usually but not always win; ties never resolve identically every match.
- `matchStart` tells each client its squad's insertion name (`INSERTED: NE PARK` in the run HUD title block, first 5s).

## 4) Planning-table contracts (spec §10)

- **Data-driven generation, zero hardcoded lists** (scale-first memory): contract templates derive objectives from map data — `extractBlueprint(kind@building)` from scannable flags, `extractPowerups(type, n)`, `extractFromBuilding(building, n items)`. A pure generator in `packages/game` rolls 3 offers seeded by `(playerId, dayStamp)` — deterministic per player per day, no runtime randomness in the sim.
- **Payouts**: powerups and/or a bonus blueprint fragment, scaled by objective difficulty (floor depth, item count — a formula with knobs, not a table of magic numbers). Payouts expand inventory, never stats (M6 guard rail applies).
- **Flow**: planning table panel (replaces the M5 stub) lists 3 offers + active contracts (accept up to 2; `REROLL` refreshes unaccepted offers). Completion is judged server-side inside the extraction-banking transaction (the manifest already knows what was extracted); payout inserts stash rows atomically with the banking and the manifest + runOver show `CONTRACT COMPLETE: …`. Abandoning is free; incomplete contracts persist across runs until completed or abandoned.
- Persistence: `contracts` table (player_id, contract jsonb, status, accepted_at) + migration. Stateless mode: planning table read-only with the offline hint.

## 5) Tests

- Lobby: squad join/switch/cap, invite-hash preselect, host-start lock.
- Sim: each verb's loot/revive/eliminate outcome + cracked-plate invariant; channel durations from config; plea cooldown; plea event reaches viewers in OTHER squads through the filter (explicit bypass test); grey invariants.
- Assignment: pure-function suite — spacing hard rule beats unanimous preferences; ~80% weighting statistically over seeded matchIds; points < squads+2 rejected by validation; every Downtown insertion point passes the spawn-clearance sweep.
- Contracts: generator determinism per (player, day); server completion inside the banking transaction (extract exactly the objective → payout rows + manifest line; near-miss → no payout); accept-cap and reroll rules; died path never completes.
- Existing suites green in BOTH DB modes.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, two visible windows, DB up: form two one-player squads via invite links; register clashing insertion preferences → spacing rule visibly separates the squads; downed player pleas → the ENEMY client sees the distress ring; enemy performs loot-then-revive → victim stands with one cracked arc and empty inventory, looter's bays/hold gained the items; accept a contract at the planning table, complete it in-run → manifest shows the payout and the locker stash agrees.
3. Stateless boot: base + planning table degrade gracefully; solo + Map Studio untouched; zero console errors.
4. `git status` clean; atomic commits per phase (lobby squads / verbs+pleas / insertion+assignment / contracts / tests).

## Report back

`handoffs/M7-REPORT.md`: lobby flow, verb/channel numbers, plea filter-bypass design, insertion assignment algorithm + spacing default, contract template/generator shape with payout formula, verification output for both modes + the live narrative.
