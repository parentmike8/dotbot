# M8 completion report — mines, intel objects, spectate polish

## Scope and phase order

M8 was implemented in the required order. The suite was returned to green at each phase boundary before the next phase began.

1. Mine item, persistence, recipe, placement, detonation, and rotation — commit `0820228` (`Add mine item and simulation`)
2. Disguise, squad sensor, radar reveal, HUD, and interest scoping — commit `49e69ac` (`Add mine disguise sensors and radar reveal`)
3. Listening post and signal mast — commit `0cf6c80` (`Add owner-private intel furniture`)
4. Spectate camera, cycling, wiped fallback, and leave seam — commit `61d3c66` (`Polish squad spectating`)
5. Tests, live-QA line-of-sight cleanup, and this report — commit message `Cover M8 mines intel and spectate`

## 1. Mine entity, inventory, and economy

- `Item` now includes `{ kind: "mine" }`; wire, stash, loadout, preset, manifest, and banking code is `"m"`.
- Mines occupy and consume a normal bay slot. Firing places the entity at the bot's current position on its current floor and emits no placement noise.
- Unplaced mines follow ordinary inventory semantics: extraction banks them, death loses them, and the DB round-trip covers stash, loadout, and manifest.
- `fabricate-mine` is a data-table recipe gated by the `workbench` blueprint and costs one dash overcharge plus one incognito. It does not mutate any combat stat.
- Placed mines are run-scoped entities. Each records the placer bot, placer squad, floor, placement timestamp, sensor state, and viewer-specific radar reveal state.
- The per-player active cap is `maxActiveMines = 3`. A fourth placement removes the oldest active mine and emits `mineRotated`; the HUD displays `MINE ROTATED`.

### Disguise and seam visual

- The placer's squad sees a neutral-backed `X` marker.
- A radar-revealed mine uses the same `X` marker for the firing player only.
- Every other viewer receives a deterministic powerup disguise selected from the mine id. Owner, squad, and reveal identifiers are stripped from that wire entity.
- The disguised outline deliberately omits an arc whose angular length is `1 / radius`. At the default 10 px radius this is a one-pixel hairline break in the circumference. The fill, ordinary powerup glyph, and otherwise normal outline make it plausible as a dot; the one-pixel seam is the learnable tell.
- The item legend documents both `Squad mine / radar-revealed mine` and `Some dots are not dots — watch for the hairline seam`.

### Detonation and sensor numbers

- Triggering is floor-scoped and uses the existing capture-range geometry. Any non-squad bot, including an ambient grey, may trigger it.
- Detonation calls the shield-segment helper to shatter the nearest intact plate relative to the impact angle. It cannot break more than one plate.
- If no intact plate exists, or the shattered plate was the last intact plate, the target is downed.
- Detonation emits `mineDetonation` noise at loudness `1.0` and uses the existing noise-ring renderer.
- `mineSenseRadius` defaults to 300 px. While a non-squad bot remains in range, `mineSensor` is emitted every `mineSensePingMs = 2000` ms to the placer's squad only.
- The client renders each sensor event as a cyan ring expanding from 12 to 66 px while fading over two seconds.
- Radar uses its existing 600 px default radius and eight-second duration. A mine in that pulse receives a reveal timer for only the radar-firing bot.

## 2. Intel furniture and private payloads

The base object/slot/recipe/glyph tables now include two wall-only singletons:

| Object | Blueprint gate | Default cost | Match information |
| --- | --- | --- | --- |
| Listening post | `serverRack` | 2 radar + 1 incognito | Ambient-grey counts per building |
| Signal mast | `generator` | 2 radar + 1 dash overcharge | One deterministic blueprint-dot plan tick |

Both objects are data-driven through the same base catalog, zone validation, singleton validation, recipe sweep, and glyph table as existing furniture. The no-combat-stats recipe guard covers both rows.

The owner-only wire payload is:

```ts
type MatchIntel = {
  greyDensity?: Array<{
    buildingId: string;
    buildingName: string;
    count: number;
  }>;
  signal?: {
    dotId: string;
    blueprintId: string;
    position: { x: number; y: number };
    floorId: string;
    expiresAtTick: number;
  };
};
```

- The listening-post count is computed from the actual ambient bots after this match's simulation spawn, not from authored-map assumptions.
- Signal selection sorts active blueprint dots and indexes them with a deterministic FNV seed of `matchId + playerId`.
- The signal defaults to 60 seconds. The per-snapshot owner payload drops `signal` as soon as its dot is inactive or the expiry tick is reached.
- `Room` authorizes the payload from the owner's persisted base furniture before passing it into the viewer interest context. Non-owners receive no field rather than zero/empty substitutes.
- `NetSession` preserves the immutable density table and accepts the lifecycle update for `signal` on snapshots.
- The insertion overlay shows density for the first five seconds; the legend remains its post-insertion surface. The signal is a pulsing blue plan-tick rendered only on its actual floor/context.
- `NoopPersistence.getMatchIntelObjects()` returns no objects, so stateless runs cannot manufacture or leak intel.

## 3. Spectate polish

- A died/given-up player selects living squadmates in deterministic id order. Space or the visible `SPECTATING <NAME>` control advances and wraps the selection.
- Camera handoff uses an exponential 180 ms lerp on death and on cycle rather than snapping.
- The existing server interest rule was sufficient: squad entities remain included across floors and the spectator's physics-floor context follows living squad members. Protocol coverage verifies this explicitly; no broader enemy-interest rule was added.
- A fully wiped squad renders the static sheet overview and keeps the run timer without expanding the already-authorized entity set.
- `LEAVE TO BASE` remains visible in both living-squadmate and wiped modes.
- Leaving after the death outcome has already been recorded does not write a second match outcome; DB coverage asserts a single participant row.

The live pass also exposed that the line-of-sight polygon's closing edge was being stroked as map art, producing a long diagonal through the sheet. The fog cutout remains, but its outline is no longer drawn. The apparent one-piece shields in the close-range detonation screenshots were intentional QA configuration (`maxShields = 1`) used to isolate a single mine hit; production remains at the three independently rendered shield plates in `defaultGameConfig`.

## 4. Automated verification

Every command used Node 20.20.0 through `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Database verification used only `postgresql://postgres:postgres@127.0.0.1:55432/dotbot`; host port 5432 was never addressed.

- `pnpm typecheck` — **PASS** across game, protocol, client, and server.
- Stateless `pnpm test` with `DATABASE_URL` absent — **PASS**:
  - game: 110 passed
  - protocol: 13 passed
  - client: 18 passed
  - server: 9 passed, 7 expected DB-only skips
  - total: 150 passed, 7 skipped
- DB `pnpm test` with the exact port-55432 URL — **PASS**:
  - game: 110 passed
  - protocol: 13 passed
  - client: 18 passed
  - server: 16 passed
  - total: 157 passed
- `pnpm build:all` — **PASS**:
  - Vite transformed 767 modules and produced the client bundle.
  - The Node 20 server bundle completed at 4.0 MB.
  - The only build diagnostics were the existing large-chunk size advisories.

M8-specific coverage includes:

- silent placement, bay consumption, cap rotation, grey triggering, one-plate shatter, and plateless downing;
- disguise determinism, seam flag, squad `X`, radar-firer reveal, and mine owner/squad id stripping;
- sensor delivery to the placer's squad only and only while an intruder remains in radius;
- `"m"` stash/loadout/manifest round-tripping and fabrication prerequisites/costs;
- actual spawn-derived density, owner-only interest, deterministic signal seed, capture expiry, timeout expiry, and stateless omission;
- spectator squad-context retention, deterministic cycle/wrap, wiped overview, and no duplicate outcome write.

## 5. Live DB narratives — two visible windows

Two independent visible identities used the `localhost` and `127.0.0.1` origins against the DB-backed server.

### Mine and spectate narrative

- The owner account learned the workbench blueprint and fabricated two mines through the visible fabricator panel. Both requests returned `FABRICATED Mine`; the base/loadout then exposed the two `×` bays.
- In a two-squad run the owner placed both mines. The owner window showed squad `X` marks; the rival window showed ordinary powerup-dot presentations with the hairline outline break. Placement produced no noise ring.
- With the rival inside the 300 px sense radius, the owner window visibly received the repeated expanding cyan sensor rings.
- The rival fired its radar bay; the bay was consumed and the remaining in-radius mine switched to the `X` reveal presentation only in that window.
- A controlled close-range continuation isolated detonation from ordinary collision: one mine removed the only test plate (`1/1` to `0/1`), downed the bot, and rendered the loud expanding noise ring. Production defaults were not changed by this harness.
- `GIVE UP` produced `SPECTATING ALPHA WING` with a smoothly following camera. The visible spectate control exercised the cycle path, `LEAVE TO BASE` remained present, and it returned to `DOTBOT / HOME BAY`.
- A separate wiped continuation displayed `SQUAD WIPED · MAP OVERVIEW`, the live timer, and `LEAVE TO BASE`.

### Listening-post and signal-mast narrative

- On the standard map the owner insertion overlay showed `MERCY CLINIC 1`, `CIVIC TOWER 2`, `LOT 6 DEPOT 1`, and `BEACON HOUSE 2`. A manual count of the spawned ambient bots matched those four rows. The non-owner window had no density table.
- The owner-only signal lifecycle was then isolated with the selected blueprint dot placed at the insertion test point. The owner rendered the blue plan tick while the non-owner at the same match point did not receive it.
- After the shared dot completed its capture channel, the owner's plan tick disappeared on the next snapshot. Automated room coverage independently verifies the production 60-second timeout path.

The controlled narrative servers changed only runtime tuning/map placement to make a visual event deterministic; no QA tuning or authored-map mutation was written into the repository.

## 6. Stateless and escape-hatch narrative

- Restarting with `databaseUrl: null` logged the expected graceful-degradation notice and kept the server available.
- Base booted visibly as `OFFLINE — NO STORAGE LINK`; persistence-backed recipes remained read-only and no match intel was present.
- `?solo` opened the playable Downtown sandbox with three shields, bays, run timer, rivals, and touch controls.
- `?studio` opened Map Studio with the Downtown building list and layer controls.
- The final browser log inspection contained no error-level console entry. The only page diagnostic was the pre-existing Rapier initialization deprecation warning.

## Exit-criteria status

1. Typecheck, both test modes, and production builds: **PASS**.
2. Two-window mine, sensor, detonation, radar, spectate, density, and signal-capture narratives: **PASS**.
3. Stateless base, no intel, solo, Map Studio, and no console errors: **PASS**.
4. Five atomic commits and clean worktree after the final report commit: **PASS**.
