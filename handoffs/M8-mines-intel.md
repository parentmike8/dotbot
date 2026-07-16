# Handoff M8: Mines, intel objects, spectate polish — the roadmap closer

**Agent brief.** The last build milestone before the playtest window. Three pieces: mines (deployable sensor-traps disguised as dots), the two intel furniture kinds (listening post, signal mast — the canonical "information, never stats" upgrades), and the deferred spectate polish from M2. Design authority: roadmap M8 (spec §3, §6) + owner rulings below. Single lane, whole repo, phases in order — each leaves the suite green.

**Preconditions:** M7 and M6-B complete and audited (`handoffs/M7-REPORT.md`, `handoffs/M6B-REPORT.md`, audit at `git log`). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432** (never touch `covet-postgres` on 5432). Browser checks need visible windows.

## 1) Mines (sim + protocol + economy)

- **Item model**: new variant `{ kind: "mine" }`, wire/persistence code `"m"`. Carried in bays/hold, banked to stash, lost on death — exactly like powerups. Fabricable: recipe gated by the `workbench` blueprint, cost `1 dashOvercharge + 1 incognito` (knobs).
- **Placement**: firing a bay holding a mine PLACES it at the bot's position (edge-triggered like every bay fire; noisy is WRONG here — placement emits NO noise, that's the point of a trap; incognito rules don't apply because there's nothing to suppress). A placed mine is a sim entity anchored to its floor.
- **Disguise**: to everyone outside the placer's squad, a mine renders as an ordinary powerup dot — the disguise glyph is picked deterministically from the mine id — with the **hairline seam tell** (a 1px break in the dot outline; subtle, learnable, document the exact visual in the report). The placer's squad sees it X-marked. The legend gains both rows (own mine marker + "some dots are not dots" seam education).
- **Detonation**: a non-squad bot entering capture range detonates it: **exactly one plate shattered** (full break on the nearest plate via the existing shield code — the bounded exception to collision-only damage). Owner ruling: a bot with NO intact plates is downed by a mine, consistent with every other unshielded hit. Greys DO trigger mines (ambient hazard is counterplay — you can herd greys through suspect dots). Detonation emits a loud noise event.
- **Sensor role** (owner addition): while any non-squad bot is within `mineSenseRadius` (default 300px) of a live mine, the PLACER'S squad gets a fading ping at the intruder's position every `mineSensePingMs` (default 2000ms) — through walls, floor-scoped, delivered like radar pings (squad-private intel through the interest filter).
- **Radar counterplay**: a radar pulse reveals mines within its radius to the firing player — revealed mines render as X-marked to that player for the radar's duration.
- **Active cap**: `maxActiveMines` per player (default 3). Placing beyond the cap despawns the OLDEST mine (a rotating sensor net, not a punishment; the HUD notes `MINE ROTATED`).
- Mines are run-scoped: unplaced carried mines extract/bank normally; placed mines vanish at match end.

## 2) Intel furniture (base + matchStart intel)

Two new fabricable wall singletons — pure information, the guard-rail test extends to them:

- **Listening post** (gated by the `serverRack` blueprint, cost knobs ~`2 radar + 1 incognito`): owners receive `intel.greyDensity` in `matchStart` — the count of ambient greys per building for THIS match, computed server-side at spawn time. Render as a small title-block table during the insertion overlay (first 5s alongside `INSERTED: …`) and afterwards from the pause/legend surface. Non-owners get nothing (omit the field, don't send zeros).
- **Signal mast** (gated by the `generator` blueprint, cost knobs ~`2 radar + 1 dashOvercharge`): at insertion the server seeds (matchId + playerId) one blueprint dot on the map and sends its location + kind to the owner only: a blue plan-tick marker renders at that position until the dot is captured by anyone or 60s elapses (knob). Owner-private through the interest filter exactly like radar pings.
- Both derive their gates and glyphs through the existing recipe/zone/glyph data tables — zero special-case branches. New glyphs drawn to the catalog standard.

## 3) Spectate polish (the M2 leftover)

- A dead/given-up player in a live match spectates: camera follows a living squadmate, `SPECTATING <NAME>` in the title block, Space cycles squadmates, and the existing squadmate-always interest rule means the server already feeds the right entities — verify rather than rebuild; fix the filter only if a spectator provably sees less than the spectated squadmate's context.
- Squad fully wiped → fall back to a static map overview (sheet view, no entity intel beyond what interest already allows) with the run timer.
- `LEAVE TO BASE` is always visible while spectating; leaving mid-match keeps the existing outcome semantics (already recorded at death — verify no double-write).
- Smooth camera handoff (lerp, no teleport cut) on death → spectate and on cycle.

## 4) Tests

- Mines: placement consumes the bay + respects cap-with-rotation; disguise/seam data reaches non-squad viewers while the squad sees X (wire-level assertions); detonation breaks exactly one plate, downs a plateless bot, and is triggered by greys; sensor pings reach only the placer's squad and only while an intruder is in radius; radar reveal flag reaches only the radar firer; banked `"m"` round-trips stash/loadout/manifest.
- Intel: listening-post owners (and only owners) get `greyDensity` matching the room's actual ambient spawn counts; mast marker seeds deterministically, expires on capture and on timeout; neither ships to non-owners (interest-level tests).
- Recipes: new rows covered by the existing data sweeps (zones, glyphs, gates exist in Downtown, no combat-stat keys).
- Spectate: dead member keeps receiving squad-context snapshots; cycle order; wiped-squad fallback; no duplicate outcome writes on leave-after-death.
- Existing suites green in BOTH DB modes.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, two visible windows, DB up: fabricate mines → place two → the enemy window sees plausible dots with the seam tell while the placer sees X marks → enemy walks near one: placer gets sensor pings; enemy touches it: exactly one arc shatters and the noise draws attention → radar from the enemy reveals the second mine as an X → placer dies and spectates their AI wingmate, cycles, then GIVE UP → base. Second narrative: listening-post owner sees the grey-density table at insertion matching a manual count; mast marker appears, then expires when the marked dot is captured.
3. Stateless boot degrades gracefully (recipes read-only; no intel fields); solo + Map Studio untouched; zero console errors.
4. `git status` clean; atomic commits (mine item+sim / disguise+sensor+radar / intel furniture / spectate / tests).

## Report back

`handoffs/M8-REPORT.md`: mine entity + disguise/seam visual spec, sensor/detonation numbers, intel payload shapes and their interest scoping, spectate changes (or confirmation the filter already sufficed), verification output for both modes + the two live narratives.
