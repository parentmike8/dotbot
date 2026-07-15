# M6-B completion report — footprint expansion

## Result and atomic sequence

M6-B is complete. The persistent base can now own and render a purchasable second floor with six parity-locked F1 placement slots, one authored walk-through stair pair per shell, atomic upgrade persistence, and floor-aware interaction and placement UI. The expansion adds space and storage/capability opportunities only; it does not encode or mutate any combat statistic.

The requested atomic implementation sequence is:

1. `2f2b255` — `Add canonical second-floor slot roster`
2. `316fd6e` — `Author second-floor shell geometry`
3. `a5ca8fc` — `Add transactional second-floor purchase`
4. `072ee1f` — `Make the persistent base floor-aware`
5. Final verification/report commit — transaction, capacity, and active-floor seam tests plus this report

Every command used Node `v20.20.0` through `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. All database migration, test, seed, and live-narrative traffic used `postgresql://postgres:postgres@127.0.0.1:55432/dotbot`. The service on host port 5432 was never touched. The repository `.env` still points at 5432, so every DB-linked command and dev-server launch used an explicit 55432 override.

## Canonical roster and validation

The ten legacy ground ids and zones are unchanged. Every expanded shell exposes the same following sixteen-slot roster; an unexpanded shell exposes only the first ten.

| Floor | Wall slots | Floor slots |
| --- | --- | --- |
| GROUND | `wall-nw`, `wall-n`, `wall-ne`, `wall-east`, `wall-west`, `wall-se` | `floor-nw`, `floor-center`, `floor-ne`, `floor-south` |
| F1 | `up-wall-a`, `up-wall-b`, `up-wall-c`, `up-wall-d` | `up-floor-a`, `up-floor-b` |

`PlacementSlot` and `BASE_SLOT_DEFS` now carry `floor: "GROUND" | "F1"`. `validateBaseLayout(layout, { expanded })` rejects any F1 id unless expansion ownership is supplied, and `createBaseMap(layout, shell, { expanded })` applies the same rule before materializing either plan. Server parsing recognizes the complete canonical roster, while the persistence transaction checks the authenticated player's ownership; this gives an unauthorized but structurally valid F1 layout the required 409 instead of misclassifying it as malformed input.

Singleton validation still traverses the complete sparse layout, so fabricators, bay consoles, planning tables, and repair benches cannot be duplicated across floors. Locker capacity also derives from every layout row, independent of floor.

## Per-shell F1 geometry

- **WORKSHOP** — a west/south mezzanine over the south wing and west hall, bounded by a low parapet with a 120 px stair-side opening. The stair rises along the west hall. Two composed window bands and the six canonical slots keep the loft visually tied to the L-plan below.
- **HANGAR** — a utility gallery covers only the north/alcove end so the main bay remains visibly double-height. Its paired stair sits in the north-east working corner, with the gallery's south parapet broken at the stair approach.
- **BERTH ROW** — an upper commons repeats over the ground commons while the berth block remains single-storey. The stair comes off the commons' west side and the south edge stays open at its approach.

Each expanded map contains `player-base:GROUND` and `player-base:F1`. Its ground `up` and F1 `down` links share one authored run, target each other's plan id, and use Downtown's existing entry/exit-half crossing logic. The maximal-furnishing flood sweep covers all sixteen object approaches, both stair mouths, and the deployment threshold for all three shells. Existing ten-slot unexpanded sweeps remain unchanged.

## Purchase and persistence transaction

`expansion-secondFloor` is shared recipe data. It has output `{ kind: "expansion", upgradeId: "secondFloor" }`, no blueprint requirement, and the symmetric tuning knob `SECOND_FLOOR_COST_PER_POWERUP = 6`: Health 6 + Radar 6 + Dash overcharge 6 + Incognito 6, or 24 total items.

Migration `0006_lazy_franklin_storm.sql` adds the future-facing `base_upgrades(player_id, upgrade_id, acquired_at)` table with `(player_id, upgrade_id)` as its primary key. No second-floor-specific column exists.

`POST /api/base/fabricate` uses one transaction:

1. Resolve static recipe data and lock the player.
2. Lock/read the complete layout and owned-upgrade rows.
3. Reject an already-owned expansion before touching stock.
4. Apply blueprint/object/slot gates for the other output kinds, including expansion-aware F1 validation.
5. Lock all STASH rows and prove every complete cost before any deduction.
6. Deduct oldest matching rows.
7. Insert either furniture, an item, or the `base_upgrades` row, then commit.

Insufficient stock rolls back without an upgrade or partial deduction. A repeat purchase returns 409 before the stock path. `GET /api/base` and every refreshed mutation payload now carry `upgrades: string[]`. Saving a layout also locks/reads ownership inside its transaction before accepting F1 rows. Stateless persistence returns `upgrades: []`, and its read-only fabricator row is disabled with the offline hint.

## Floor-aware client seams

- `BaseSession` rebuilds `createBaseMap` from `base.upgrades`. A successful expansion response queues the shell's ground stair id through the existing draw-on hook, closes the panel, and displays `FLOOR 1 COMMISSIONED`.
- Renderer floor art now keeps individually addressable stair views. `draftObject` accepts either a placed object or a stair fixture, so the new run draws on with the same outline/detail masking system used by fabrication.
- `findBaseTarget` resolves the floor plan whose physics floor matches the bot snapshot's `floorId`. Objects and empty slots are read only from that plan. The deployment threshold remains interactive only on the shared outdoor/GROUND plane.
- Placement markers are filtered by `slot.floor` into their owning floor art. Fabrication and move pickers offer every owned floor and label choices such as `F1 / up-wall-a`; unexpanded accounts filter the six upper slots before compatibility checks.
- Expanded shell previews retain the existing ground SVG and add `+ FLOOR 1`. Unexpanded previews have no tag.
- The expansion recipe remains visible after purchase as a disabled `OWNED` row. Offline rows state `OFFLINE — NO STORAGE LINK`.

The active-floor client test deliberately overlays an F1 locker and a GROUND fabricator at the same coordinates. A GROUND bot resolves the fabricator, an F1 bot resolves the locker, and F1 never resolves the deployment threshold.

## Cost-curve observation

At 24 raw powerups, the expansion costs the same input volume as twelve ordinary furniture recipes or twelve one-output powerup conversions, and eight repair benches. In return it unlocks six slots, including four possible locker positions, but no immediate combat benefit. Against M6's 2-item furniture baseline this reads as the intended long-horizon sink rather than another routine craft. Recommendation: keep 6×4 for the first economy observation window; measure time-to-purchase and post-purchase locker saturation before retuning. No M6 recipe or combat value was changed here.

## Verification

### Automated exit criteria

- `pnpm typecheck` — **PASS** across game, protocol, client, and server.
- `pnpm build:all` — **PASS** for the Vite client production build and Node 20 server bundle. Vite emitted only its existing large-chunk advisory.
- `DATABASE_URL` absent, `pnpm test` — **PASS**: game 107, protocol 11, client 16, server 7 passed + 7 expected DB-only skips; **141 passed, 7 skipped** total.
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/dotbot pnpm test` — **PASS**: game 107, protocol 11, client 16, server 14; **148 passed** total.
- `git diff --check` — **PASS**.

Coverage explicitly proves identical 16/10 shell parity, unauthorized F1 game rejection and server 409, maximal expanded reachability, 24-item deduction plus upgrade insertion, insufficient-stock rollback, repeat-purchase rejection without deduction, F1 locker capacity, active-floor target separation, deployment ground-only behavior, and the recipe no-combat-stat guard.

### Live visible DB narrative

The visible in-app browser stayed open throughout the DB-linked narrative.

1. The `Persist One` account was reset to the starter layout and seeded through host port 55432 with exactly 8 of each powerup plus the `locker` and `bed` blueprints.
2. At the fabricator, `SECOND FLOOR` showed the symmetric 6×4 price. Purchasing it closed the panel, displayed `FLOOR 1 COMMISSIONED`, queued the stair draw-on, and rebuilt the session with the new visible stair.
3. The bot entered the Workshop stair from its ground entry half and crossed the break line. The snapshot changed from `outdoor` to `player-base:F1` and visibility swapped to the mezzanine plan; walking back across the paired run returned it to GROUND.
4. The locker recipe picker visibly offered `F1 / up-wall-a / wall`. Fabrication persisted `up-wall-a: locker`; the locker panel then showed `STASH 6/60`, proving the third locker raised capacity from 40 to 60 across floors.
5. A bed was first fabricated into `GROUND / floor-nw`, opened through its diegetic object panel, and moved through the picker to `F1 / up-floor-a`.
6. Expanded Workshop, Hangar, and Berth Row were each rendered in turn. Their previews all showed `+ FLOOR 1`, while each actual ground plan showed its own authored stair geometry.
7. Reloading on Berth Row preserved the shell, `secondFloor` ownership, the F1 locker, and the moved F1 bed.
8. A separate `Observer Two` identity had `upgrades: []`. Its map showed no stair or upper plan, its locker picker offered only `GROUND / wall-west` and `GROUND / wall-se`, and all three shell previews omitted `+ FLOOR 1`.

### Stateless and regression narrative

- Restarted with `DATABASE_URL` explicitly empty. Startup reported `DATABASE_URL is unset; continuing without database persistence.`
- A fresh base tab booted normally as `OFFLINE — NO STORAGE LINK`, with no owned expansion or F1 map.
- `?solo` rendered the existing playable Downtown sandbox with run, inventory, and controls intact.
- `?studio` rendered Map Studio with all four buildings and layer controls intact.
- Expanded DB, unexpanded DB, stateless base, solo, and Studio tabs each reported **zero browser console errors**. The existing Pixi/Rapier initialization deprecation warning remained non-fatal and unchanged.

## Exit-criteria status

1. Typecheck, both test modes, and production builds: **PASS**.
2. Rich-stash purchase, stair draw/walk, F1 locker/capacity, decorative move, all shells, and reload persistence: **PASS**.
3. Unexpanded filtering, stateless degradation, solo, Map Studio, and zero console errors: **PASS**.
4. Five atomic M6-B commits and clean worktree after the final verification commit: **PASS**.
