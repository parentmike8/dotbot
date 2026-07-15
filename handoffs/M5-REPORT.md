# M5 Report: Base-as-menu

## Result

M5 is complete. The normal client now cold-boots into a playable persistent base rather than a menu. The base owns identity bootstrap, diegetic object interactions, deployment, manifest return, furniture placement, and the storage-linked/stateless split. `/?solo` keeps the existing solo sandbox reachable and `/?studio` still opens Map Studio.

The work is split into the requested atomic sequence:

1. `e5c300b` — `Add persistent base map and placement slots`
2. `b108963` — `Boot into the playable base`
3. `cae1b98` — `Animate base objects drawing into place`
4. `224534b` — `Persist base layouts and at-risk loadouts`
5. Final tests/report commit — test seams, DB integration coverage, live-loop fixes, and this report

All commands used Node `v20.20.0` through `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Every database command and test used `postgres://postgres:postgres@127.0.0.1:55432/dotbot`; host port 5432 was not used.

## Base shell and slot data

`createBaseMap(layout)` produces a deterministic 1000×760 drawing sheet containing one 840×640 single-floor base shell. The map has one human spawn, empty bays/HOLD, no dots, no rivals, and no ambient AI. The south wall has a 120px deployment doorway and a marked channel zone immediately inside it.

Placement is driven by `MapDocument.placementSlots`, not ad-hoc placement coordinates. The shell declares ten slots:

- Six wall slots: `wall-nw`, `wall-n`, `wall-ne`, `wall-east`, `wall-west`, and `wall-se`.
- Four floor slots: `floor-nw`, `floor-center`, `floor-ne`, and `floor-south`.

Each slot has `{ id, rect, zone }`. `BaseLayout` is the persisted `{ [slotId]: BaseObjectKind }` mapping. Wall slots accept fabricators, lockers, and bay consoles; floor slots accept planning tables. The starter layout places one fabricator, two lockers, one bay console, and one planning table. Duplicate singleton objects, unknown slots/kinds, and wall/floor mismatches are rejected. Empty slots render CAD corner markers and can be selected diegetically; objects only move between compatible declared slots.

The map tests cover deterministic generation, absence of AI/dots, invalid layouts, bot-clear paths to every placement slot, and reachability of the deployment threshold under the existing clearance rules.

## Base session and panels

The default route creates a `LocalSession` on `createBaseMap(layout)` and gives it a practically unbounded run clock. There is no traditional menu in the normal boot or return path. The identity prompt is a title-block overlay on the live base, after which the bot is immediately controllable.

All interactions use the same one-second stationary channel and renderer channel ring. Moving more than the cancellation tolerance resets the channel. The panel inventory is:

- Locker: read-only itemized STASH counts and learned blueprints.
- Bay console: four at-risk loadout slots, powerup withdrawals, and returns to STASH.
- Fabricator: learned blueprints plus `FABRICATION COMES ONLINE WITH THE NEXT BASE UPGRADE PASS.` No M6 crafting logic is present.
- Planning table: `CONTRACTS — NOT YET COMMISSIONED`.
- Empty/occupied slot context: compatible declared-slot picker; there is no free placement.
- Deployment threshold: compact embedded create/join, squad roster, and host-start UI. `LEAVE TO BASE` closes deployment, clears its hash, refreshes `/api/base`, and resumes the base session.

Pure client seams now cover route selection and the threshold's one-second stationary/cancel behavior.

## Persistence and loadout transaction

Migration `0001_redundant_terror.sql` adds:

- `base_layouts(player_id, slot_id, object_kind)` with a composite primary key and player cascade.
- `players.loadout jsonb not null default '[]'`.

Registration seeds the five starter placement rows transactionally. `GET /api/base` lazily seeds existing players and returns `{ storageLinked, layout, stash, learnedBlueprints, loadout }`. `POST /api/base/layout` validates the complete mapping against the shared base definition before replacing the player's rows.

`POST /api/base/loadout` performs the full desired-state change in one transaction:

1. Lock/read the player's current loadout.
2. Return its items to STASH.
3. Validate at most four powerup codes; blueprint fragments are rejected.
4. Withdraw the requested quantities from STASH rows.
5. Write the new JSON loadout and return the refreshed base payload.

An insufficient quantity rolls the whole transaction back. At match start the server locks, reads, and clears the loadout, then materializes those items into the player's four spawn bays. Empty loadout still receives the unchanged default one-health spawn. Extraction persists carried items back to STASH. Died and timeout outcomes do not bank them, and the already-cleared loadout stays empty.

Without `DATABASE_URL`, `NoopPersistence` returns the starter layout with `storageLinked: false`, empty persistent inventory, and no loadout. The client boots the same playable base, uses localStorage for layout changes, displays `OFFLINE — NO STORAGE LINK` on the base and storage panels, disables loadout changes, and keeps the default match spawn.

## Fabrication draw-on

Furniture is addressable per object in `MapArt`. `GameRenderer.draftObject(objectId, durationMs = 1200)` is the reusable public hook for both M5 placement and M6 fabrication output.

The temporary draft uses deterministic layers:

1. Anchor-weight exterior outline, progressively clipped for the first 55%.
2. Object-specific interior detail, progressively clipped for the final 45%.
3. A moving hairline pencil tick at the active clip edge.
4. Replacement by the normal complete static glyph at the end.

Initial starter furniture drafts once on first-ever client boot. Every re-slot queues the destination object id through the same hook. Live verification found and fixed a redundant post-save layout remount that could cut the animation short; the persisted response now confirms localStorage without replacing the already-rendering optimistic layout.

## Verification

### Automated exit criteria

- `pnpm typecheck` — green across game, protocol, client, and server.
- `pnpm build:all` — green; Vite production client and bundled Node 20 server built successfully. Vite emitted only its existing large-chunk advisory.
- `env -u DATABASE_URL pnpm test` — green: game 74, protocol 10, client 11, server 4 passed + 2 DB-only skipped. Total: **99 passed, 2 skipped**.
- `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/dotbot pnpm test` — green: game 74, protocol 10, client 11, server 6. Total: **101 passed**.
- `git diff --check` — green.

The DB integration suite explicitly proves registration seeding; layout round-trip and bad slot/kind rejection; atomic withdraw/return/rollback; blueprint rejection; match-start bay population and loadout clearing; extraction re-banking; and a withdrawn-health died path leaving STASH unchanged with an empty loadout.

### Live visible browser loop, database linked

The in-app browser was kept visible throughout animation/gameplay checks so requestAnimationFrame stayed active.

1. A cold boot for `M5 Live Pilot` landed directly in `DOTBOT / HOME BAY` with `STORAGE LINK ACTIVE`; no menu rendered.
2. Walking to a locker and holding still opened it with the existing bank: Health ×2, Radar ×1, and the learned `shelf` blueprint.
3. Walking to the bay console and selecting Health changed the four-slot loadout to Health + three empty bays and decremented STASH. The base bot position stayed unchanged during the transaction.
4. Walking onto the deployment zone and channeling opened the compact deployment overlay. A single-player room started with Health visibly present in in-run bay 1.
5. The bot reached the Depot extraction pad. The visible manifest reported `EXTRACTED` and kept Health ×1. `LEAVE TO BASE` returned to the playable base; reopening the locker showed Health restored to ×2.
6. A second visible two-squad room (`M5 Live Pilot` / `Persist One`) exercised the died path. `Persist One` reached 0/3 shields, the network view exposed `GIVE UP`, and clicking it produced a visible `CONSUMED` manifest with Health ×1 lost. `LEAVE TO BASE` returned that client to its base. The corresponding withdrawn-item loss semantics are covered by the DB integration case above.
7. The fabricator and planning table opened their exact M5 stub panels. Moving the fabricator from `wall-nw` to `wall-west` visibly showed the partial outline/pencil phase followed by the interior-detail/complete-glyph phase; the new slot survived a refresh.
8. The primary extraction path completed the required base → deployment → run → manifest → base loop without a traditional menu.

Fresh DB-linked browser checks ended with zero console errors.

### Live stateless browser loop

The server was restarted with an explicitly empty `DATABASE_URL`; its startup log confirmed that it continued without database persistence.

- Cold boot still rendered the playable base with `OFFLINE — NO STORAGE LINK`.
- Real movement changed the bot's reported world position from x=330 to x=426.
- The locker opened diegetically with the offline hint, empty STASH, and no learned blueprints.
- `/?solo` rendered the existing `DotBot playable sandbox`.
- `/?studio` rendered Map Studio with its selection and layer controls.
- Fresh stateless base and solo/studio checks ended with zero console errors.

## Exit status

All four M5 exit criteria are green. The final tests/report commit leaves the worktree clean.
