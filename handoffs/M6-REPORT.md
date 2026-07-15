# M6 Report: Economy-loop closure

## Result

M6 is complete. The fabricator now closes the persistent loop from extracted powerups and blueprint fragments to crafted powerups, placed furniture, increased locker capacity, repair-bench capability, and reusable bay-console loadouts. All fabrication remains option-, capacity-, information-, or cosmetic-expanding: no recipe or placed object modifies combat stats or any `GameConfig` value.

The requested atomic implementation sequence is:

1. `ac2d624` — `Add economy recipes and furniture zone rules`
2. `2e3ee87` — `Add atomic base fabrication transaction`
3. `5f41756` — `Enforce locker-backed stash capacity`
4. `ce24ede` — `Persist and apply loadout presets`
5. `c6959fe` — `Bring base fabrication panels online`
6. Final tests/report commit — recipe/glyph/transaction/capacity/preset coverage, all-slot shell reachability, live-loop corrections, and this report

Every command used Node `v20.20.0` through `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Every database command and test used `postgresql://postgres:postgres@127.0.0.1:55432/dotbot`; host port 5432 was never used.

## Recipe table as landed

Recipes ship as shared game data in `content/recipes.ts`; they are not persisted and no server or client branch is keyed to a recipe id.

| Output | Cost | Gate |
| --- | --- | --- |
| Health | 2 Radar | Placed repair bench |
| Radar | 2 Incognito | Fabricator innate |
| Dash overcharge | 2 Health | Fabricator innate |
| Incognito | 2 Dash overcharge | Fabricator innate |
| Bed | 1 Radar + 1 Dash overcharge | `bed` blueprint |
| Conference table | 1 Radar + 1 Dash overcharge | `conferenceTable` blueprint |
| Cot | 1 Radar + 1 Dash overcharge | `cot` blueprint |
| Couch | 1 Radar + 1 Dash overcharge | `couch` blueprint |
| Counter | 1 Radar + 1 Dash overcharge | `counter` blueprint |
| Desk | 1 Radar + 1 Dash overcharge | `desk` blueprint |
| Filing cabinet | 1 Radar + 1 Dash overcharge | `filingCabinet` blueprint |
| Fridge | 1 Radar + 1 Dash overcharge | `fridge` blueprint |
| Generator | 1 Radar + 1 Dash overcharge | `generator` blueprint |
| Locker | 1 Radar + 1 Dash overcharge | `locker` blueprint |
| Reception desk | 1 Radar + 1 Dash overcharge | `receptionDesk` blueprint |
| Server rack | 1 Radar + 1 Dash overcharge | `serverRack` blueprint |
| Shelf | 1 Radar + 1 Dash overcharge | `shelf` blueprint |
| Tool cabinet | 1 Radar + 1 Dash overcharge | `toolCabinet` blueprint |
| Workbench | 1 Radar + 1 Dash overcharge | `workbench` blueprint |
| Repair bench | 2 Radar + 1 Dash overcharge | `workbench` blueprint |

The 15 ordinary furniture recipes exactly equal the set of scannable kinds for which M4 actually generates Downtown blueprint fragments. The repair bench is the one additional functional kind authorized by M6. Tests assert that equality, positive costs, unique ids, powerup/furniture-only outputs, zone coverage, renderer-glyph coverage, and the absence of combat-stat keys or `GameConfig` mutation.

## Zone-rule data

`BASE_KIND_ZONES` is the shared `Record<BaseObjectKind, readonly ("wall" | "floor")[]>` authority used by both map validation and server fabrication:

- Wall only: fabricator, bay console, repair bench, locker.
- Either wall or floor: shelf.
- Floor only: planning table and the remaining decorative furniture kinds.

`BASE_OBJECT_KINDS`, `BASE_KIND_ZONES`, and renderer glyphs are exhaustively covered. The singleton set remains fabricator, bay console, planning table, and repair bench. Every shell retains the identical six wall plus four floor slot roster. The maximal-layout sweep now fills all ten slots with M6 furniture; the Berth Row's existing `floor-south` slot was moved out of its central corridor so the richest solid layout keeps every object and the deployment threshold reachable without changing slot parity.

## Fabricate transaction

`POST /api/base/fabricate { recipeId, slotId? }` delegates to one Postgres transaction:

1. Resolve the recipe from shared static data and lock the player.
2. Lock/read the complete base layout.
3. Verify any learned-blueprint and placed-object gate.
4. For furniture, verify a declared slot, zone compatibility, emptiness, and the complete singleton-valid layout.
5. Lock all STASH rows, aggregate each cost, and reject insufficient stock before deductions.
6. Deduct oldest matching rows, then insert either the base-layout row or one powerup STASH row.
7. Commit and return the refreshed base payload; any thrown validation or stock error rolls all writes back and surfaces as a 409 (unknown/malformed requests are 400).

The DB suite proves unlearned, insufficient-stock, occupied-slot, and zone-mismatch failures leave stock/layout unchanged; it also proves shelf and repair-bench placement, repair-gated Health conversion, item output, and unknown-recipe rejection. Stateless fabrication remains a 503 and cannot mutate local or server state.

## Furniture behavior, capacity, and banking

STASH capacity is derived every time from the placed layout: `20 × locker count`. The starter two lockers yield 40; the live third locker yielded 60. Existing over-cap developer data is left intact.

Extraction banking runs inside the existing persistence transaction. It locks layout and STASH rows, counts current occupancy, stable-sorts the run's kept items with blueprint fragments first, banks only while capacity remains, and appends overflow to `lostItems`. A fragment crossing the learning threshold is learned and all stored fragments of that blueprint are removed inside the same transaction, freeing their occupied space for later items in the same manifest. The adjusted manifest is what both `match_participants.extracted_manifest` and the live `runOver` message receive. The manifest renders `STASH FULL — LOST: N` whenever an extracted run overflows.

The DB suite covers fragment-first behavior at 39/40, powerup overflow in the same manifest, persisted manifest content, and an already-over-cap STASH refusing new banking without truncating existing rows.

## Presets and client flow

Migration `0003_equal_skaar.sql` adds `players.presets jsonb not null default '[]'`. `GET /api/base` returns up to three named, four-powerup templates. `POST /api/base/presets` performs a validated full replacement. `POST /api/base/presets/apply` locks the player, returns the current at-risk loadout to STASH, withdraws available preset entries in order, writes the partial applied loadout, and reports grouped missing quantities. Blueprint cargo and oversized preset/loadout shapes are rejected.

The fabricator panel displays every locked and unlocked row, current costs/missing amounts, blueprint names, and the repair-bench requirement. Furniture recipes open only compatible empty declared slots; a successful response queues the exact new base-object slot through `GameRenderer.draftObject`. Powerup recipes remain in-panel and update STASH with a confirmation line. The locker panel renders `STASH used/capacity`. The bay console saves, applies, and deletes named presets alongside normal withdrawals/returns. Decorative furniture and the repair bench have diegetic panels and remain movable through the shared slot picker.

Without a database, the full recipe catalog remains visible but every recipe is disabled under `OFFLINE — NO STORAGE LINK` and `READ-ONLY RECIPE CATALOG`.

## Verification

### Automated exit criteria

- `pnpm typecheck` — green across game, protocol, client, and server.
- `pnpm build:all` — green; Vite client and bundled Node 20 server built successfully. Vite emitted only its existing large-chunk advisory.
- `DATABASE_URL= pnpm test` — green: game 86, protocol 10, client 12, server 4 passed + 5 DB-only skipped. Total: **112 passed, 5 skipped**.
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/dotbot pnpm test` — green: game 86, protocol 10, client 12, server 9. Total: **117 passed**.
- `git diff --check` — green.

### Live visible browser narrative, database linked

The in-app browser stayed visible for the entire gameplay/animation pass.

1. A fresh `M6 Live Pilot` boot showed `STORAGE LINK ACTIVE`. SQL seeding on host port 55432 supplied only the learned `shelf`, `workbench`, and `locker` blueprints plus test powerups.
2. The fabricator visibly listed locked recipes. Choosing Shelf and `floor-nw` produced the partial outline/interior draft frame and then the completed shelf, with `FABRICATED SHELF · floor-nw`.
3. Health was initially disabled with `REQUIRES: REPAIR BENCH`. Fabricating the repair bench into `wall-west` enabled Health; clicking it converted exactly 2 Radar into 1 Health in STASH.
4. Fabricating a locker into `wall-se` opened a real locker panel showing `STASH 16/60`.
5. At the bay console, Health + Radar were saved as `FIELD KIT`; `APPLY` completed with `PRESET APPLIED` and the same two at-risk bays.
6. Workshop, Hangar, and Berth Row each rendered the same persisted shelf, repair bench, third locker, and starter furniture. The all-ten-slot automated validation also passed for every shell.
7. STASH was seeded from 14 to exactly 60. The live run carried Health + Radar to the Depot pad. Its visible `EXTRACTED` manifest showed both under Lost and `STASH FULL — LOST: 2`. A direct query then confirmed STASH still equaled 60 and the persisted participant manifest was exactly `lostItems: ["h", "r"]`, `keptItems: []`.

No browser console errors occurred during the DB-linked narrative.

### Live stateless and regression narrative

The server was restarted with an explicitly empty `DATABASE_URL`; startup reported `DATABASE_URL is unset; continuing without database persistence.`

- The base booted with `OFFLINE — NO STORAGE LINK`.
- The fabricator opened diegetically with all 20 recipes visible and disabled, plus the exact offline/read-only hints.
- `/?solo` rendered the existing `DotBot playable sandbox` with its run, inventory, controls, and default Health bay.
- `/?studio` rendered Map Studio with all four building selections and its layer controls.
- The complete browser tab history ended with zero console errors. The existing Rapier initialization deprecation warning remained non-fatal and unchanged.

## Exit status

All functional M6 exit criteria are green. The six M6 commits contain only the requested implementation, verification, and report files. An unrelated untracked `handoffs/M7-contracts-social.md` appeared during this single-lane run; it was deliberately preserved and excluded from M6 rather than claimed or deleted.
