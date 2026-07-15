# M7 completion report — contracts, insertion, squad social

## Scope and phase order

M7 was implemented in the required order. The full suite was green at the end of each phase before the next phase began.

1. Lobby squads — commit `2bc7989` (`Add lobby squad formation`)
2. Downed verbs and global pleas — commit `898b403` (`Add downed verbs and global pleas`)
3. Insertion data, preferences, and assignment — commit `eea828c` (`Add preference-weighted squad insertions`)
4. Planning-table contracts — commit `0e2b5a5` (`Add atomic planning-table contracts`)
5. Final manifest-wire coverage, load-sensitive DB test budget, this report — commit message `Verify M7 social contracts`

## 1. Lobby squad formation

- The lobby renders Alpha, Bravo, and Crew 3 as squad columns with a hard cap of three players each.
- Players may join or switch until host start locks the room. Late joiners without a requested squad go to the emptiest squad.
- Each squad exposes `COPY INVITE`; the copied URL is `/#/r/CODE?squad=<squad-id>`. The hash preference is applied on join and remains switchable until start.
- AI backfill remains two bots per active squad and is shown explicitly as `AI WINGMATE AT START` in empty future slots.
- Protocol and room tests cover join, switch, cap rejection, preferred invite routing, late-join balancing, and host-start lock.

## 2. Downed interaction verbs and pleas

The three hostile verbs are configured, not hardcoded in channel logic:

| Verb | Default channel | Result |
| --- | ---: | --- |
| `consume` | 3000 ms | Eliminate and loot all cargo; overflow spills |
| `reviveClean` | 2500 ms | Revive with no loot and the one-cracked-plate invariant |
| `lootThenRevive` | 4500 ms | Loot all cargo, then revive with one cracked plate |

All three are stationary noisy channels. The client exposes `C`, `R`, and `F` plus tap targets, and the active ring carries the current verb label.

Pleas use a configurable 10,000 ms cooldown. They are emitted as `SimEvent`s and the protocol interest filter explicitly returns them before floor/range filtering, so every squad receives the event. Clients render the fading ring in the downed bot's relationship hue; squadmates additionally retain the persistent downed edge arrow. Ambient-grey bots are excluded from loot, consume, hostile revive, and plea paths.

## 3. Insertion points and assignment

- `MapDocument.insertionPoints` is required data. Downtown defines six authored points: NW CORNER, NE PARK, WEST GATE, EAST GATE, SW YARD, and SE COURT.
- Validation requires at least `active squads + 2` points and sweeps all three member footprints at every point against bounds, solid geometry, and member overlap.
- Planning-table preference is persisted in nullable `players.insertion_pref` by migration `0004_insertion_preference.sql` and is shown on the data-derived mini-map.
- Squad preference is the plurality vote; ties resolve to the earliest joining member who voted for a tied point.
- `assignSquadInsertions` performs an exact permutation search after rejecting assignments below the hard 900 px pairwise spacing default. Six points and three squads are only 120 permutations; the implementation rejects more than ten points so a future scale-up cannot silently turn the brute-force solver pathological.
- Valid assignments are scored with a deterministic match-seeded 80/20 preference lane: a matching preference contributes `+1` in the 80 lane and `-1` in the 20 lane, with `0.001` deterministic assignment jitter for remaining ties.
- Room spawn anchors now come only from the chosen map point. `matchStart` carries the assigned name and the run title shows `INSERTED: …` for five seconds.

## 4. Planning-table contracts

`packages/game/src/contracts.ts` derives every template from map data:

- `extractBlueprint`: unique scannable object kinds paired with their source building.
- `extractPowerups`: powerup types discovered from all outdoor/building dot spawns; counts are deterministically derived as 2 or 3.
- `extractFromBuilding`: one template per building; count is `min(4, 2 + floor(floorDepth / 3))`.

Three daily offers are generated deterministically from `(playerId, UTC day stamp, persisted reroll index)`. Accept is capped at two, reroll replaces only unaccepted offers, abandon is free, and incomplete contracts persist.

Payouts are inventory-only. The formula starts at one powerup, adds one per four difficulty up to three, and adds a deterministically selected blueprint fragment at difficulty 6+. Powerup and blueprint types are themselves derived from map data. No payout mutates shields, movement, damage, dash, or any other combat stat.

Migration `0005_contracts.sql` adds the JSONB-backed contract rows and persisted reroll counter. Extraction completion is judged inside `recordExtraction` while the player, active contracts, stash banking, payout rows, manifest, and contract status are in one DB transaction. Exact matches complete; near misses and died/timeout paths do not. The authoritative `runOver` payload and manifest include the completion title and decoded payout.

Stateless mode returns deterministic read-only offers and rejects accept/reroll/abandon writes with the offline path.

## 5. Verification

All commands used Node 20.20.0 via `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. PostgreSQL was addressed only through host port 55432; the service on host port 5432 was not touched.

### Automated gates

- `pnpm typecheck` — PASS.
- `pnpm test` with `DATABASE_URL` absent — PASS: 129 passed, 6 expected DB-only skips.
- `pnpm test` with `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/dotbot` — PASS: 135 passed.
- `pnpm build:all` — PASS: Vite client production build and Node 20 server bundle.
- Each of the four implementation phase boundaries also ended with both DB modes green before the next phase began.
- The DB integration movement wait was raised from 5 seconds to 10 seconds after one full-suite run exhausted the helper under load. The isolated test and the complete DB suite then passed; no production timeout changed.

### Live DB narrative — two visible browser identities

- Used separate visible `localhost` and `127.0.0.1` origins for independent device identities.
- Created a room in the first window and joined Bravo in the second through `/#/r/ZPXS?squad=bravo`, producing two one-player squads with visible AI backfill slots.
- Both players registered `NW CORNER` at their planning tables. The live run visibly placed the two squads in separated west/east sectors instead of honoring both votes at one point, demonstrating that the 900 px spacing rule won over the clash.
- The Bravo player was downed and fired `PLEA · P`; the hostile Alpha window visibly rendered the fading distress rings even though it was a different squad and distant sector.
- Alpha approached the downed hostile and used `F · LOOT + REVIVE`. After the 4500 ms stationary channel, Bravo stood at `0.5/3 shields` with four empty bays while Alpha's bays increased from one Health to two Health.
- At the planning table, a contract was accepted, persisted across runs, abandoned, and rerolled through the visible UI; `EXTRACT 3 HEALTH` was then accepted and shown under `ACTIVE 1/2`.
- For a controlled banking check, the empty test account stash was seeded with Health x3 and Incognito x1, then all four items were withdrawn through the visible bay console. Incognito was consumed in-run so the extraction transaction began from an empty stash and banked only the observed run result.
- The runner extracted at NORTH PAD with Health x3. The manifest showed `EXTRACTED`, kept `Health ×3`, and `Contract complete — EXTRACT 3 HEALTH — PAYOUT · Incognito`.
- Back at base, the live locker showed `STASH 4/40`, `Health ×3`, and `Incognito ×1`. Direct DB verification matched those rows and showed the contract status as `completed`.

### Stateless and escape-hatch narrative

- Restarted with `DATABASE_URL` explicitly empty. The server emitted the expected graceful-degradation warning and remained functional.
- Base booted as `OFFLINE — NO STORAGE LINK`.
- The planning table showed the offline hint, deterministic daily offers, `READ-ONLY DAILY OFFERS`, and disabled insertion, reroll, and accept controls.
- `?solo` still opened the playable Downtown sandbox with movement/inventory/run HUD.
- `?studio` still opened Map Studio with building selection and layer controls.
- A fresh stateless browser tab reported zero console errors across base, solo, and Studio.

## Exit-criteria status

1. Typecheck, both test modes, and production build: **PASS**.
2. Two-window DB narrative (squads/invites, clashing preferences and spacing, global plea, loot-then-revive, contract banking, manifest payout, locker agreement): **PASS**.
3. Stateless base/planning degradation, solo, Map Studio, and zero console errors: **PASS**.
4. Five atomic M7 commits: **PASS** after the final verification commit. The M7-owned worktree is clean; the unrelated pre-existing untracked `handoffs/M6B-footprint-expansion.md` was deliberately preserved and not included.
