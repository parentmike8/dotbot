# M0-T3 completion report

## Data model and content

- `BotTeam` was deleted. `BotSpawn` now requires `squadId` and optionally carries `isAmbient` and `controller` (`packages/game/src/types.ts:196-201`).
- `DotBotEntity` now carries `squadId` and normalized `isAmbient` (`packages/game/src/types.ts:232-235`; spawn-to-entity at `packages/game/src/simulation.ts:280-281`; snapshot at `packages/game/src/simulation.ts:1441-1442`).
- Downtown player, Indigo, and Sky use squad `alpha`; the player declares controller `human`. The ten rivals use solo squads `rival-1` through `rival-10` and are ambient (`packages/game/src/content/downtown.ts:1283-1296`). Names, colors, positions, and floor IDs are unchanged.

## Semantic mapping audit

| Former team-keyed behavior | New key and exact implementation location |
|---|---|
| Friendly-fire skip | Same-squad comparison in `areFriendly` (`packages/game/src/simulation.ts:1433-1434`), consumed by `resolveCombat` at line 1117. `FRIENDLY_TEAMS` was deleted. |
| Revive versus consume coverage | `resolveDownedCoverage` selects by same-squad `areFriendly` (`packages/game/src/simulation.ts:1250`). |
| AI revive, consume, and hunt filters | `pickBotTarget` uses same-squad and different-squad `areFriendly` checks for friendly downed, hostile downed, visible hostile, and strategic hostile targets (`packages/game/src/simulation.ts:564-635`). |
| Initial human assignment | Constructor passes `spawn.controller ?? "ai"` to `spawnBot` (`packages/game/src/simulation.ts:146`). |
| Movement speed | `applyMovement` selects `playerSpeed` only for controller `human`, otherwise `botSpeed` (`packages/game/src/simulation.ts:993-1001`). Dash speed remains unchanged. |
| Respawn inventory | `respawnConsumedBots` assigns zero for ambient bots and one otherwise (`packages/game/src/simulation.ts:1385`). |
| Ally escort | `pickBotTarget` finds living human-controlled same-squad bots, sorts by bot ID, and escorts the first when available (`packages/game/src/simulation.ts:651-661`). |
| Banking counters | Constructor records the first human bot's squad, falling back to the first bot (`packages/game/src/simulation.ts:149-150`). `resolveExtraction` sends same-primary-squad deposits to `bankedDots`, all others to `rivalBankedDots` (`packages/game/src/simulation.ts:1316-1319`). |
| Renderer layer split | `GameRenderer.drawBots` derives the viewer squad from `playerId` and places only same-squad bots on the dynamic layer (`apps/client/src/game/renderer/GameRenderer.ts:332-339`). Other bots remain LOS-masked. |
| HUD rival count | `GameSession` counts living bots whose squad differs from the viewer's (`apps/client/src/ui/App.tsx:30-32`). Ambient bots remain included. |

## Team usages outside the mapping table

No unlisted production behavior was found.

Outside-table usages explicitly covered elsewhere in the handoff:

- Spawn/entity storage moved to `squadId` and `isAmbient` as listed in Data model and content above.
- Map-validation flood-fill seed selection moved from player team to human spawn controller (`packages/game/src/mapValidation.test.ts:72`).
- Simulation helper fixtures moved to `alpha`/`rival-1`; the rival helper also sets `isAmbient: true` to preserve former enemy respawn inventory behavior.

Two genuinely unlisted usages were found in the soak test:

- The non-player movement milestone at `packages/game/src/simulation.test.ts:864` now selects spawns whose controller is not human.
- The non-player floor-change milestone at `packages/game/src/simulation.test.ts:870` uses the same controller test.

Both are test-selection logic. The mapping is behavior-equivalent because the former player spawn was the only human-controlled spawn.

## Ambiguity and narrow resolution

The existing rival-banking test originally created a map containing only one enemy. Under the required primary-squad fallback, that sole bot becomes primary and would increment `bankedDots`, conflicting with the unchanged `rivalBankedDots === 3` assertion. The fixture now includes a distant human primary spawn (`packages/game/src/simulation.test.ts:249-253`); the rival scenario and all assertions remain unchanged.

No gameplay/tuning, shield, hue, renderer drawing, or ambient-AI behavior changes were made.

## Verification

- Before: 4 files, 56 tests.
- After: 4 files, 58 tests.
- Added: same-squad AI Dash collision immunity and different-squad ambient rivalry. Existing same-squad revive and different-squad consume tests cover the third requested case with unchanged assertions.
- `pnpm typecheck`: passed for game and client.
- `pnpm test`: 4 files passed; 58 tests passed, including determinism.
- `pnpm build`: passed with Vite 8.0.16; 739 modules transformed. Existing large-chunk warning remains.
- Exact forbidden-symbol sweep, `grep -rnE 'BotTeam|FRIENDLY_TEAMS|\.team\b' packages apps`: zero hits.
- Browser game route: alpha squad rendered visibly while distant rivals remained LOS-hidden; movement and Dash worked; rival count fell from 10 to 9 without player contact, demonstrating rival-on-rival combat; rival banking reached 1; restart reset the run. Existing revive/consume tests passed after the squad re-key. Zero console errors.
- Browser Map Studio route: rendered unchanged; Lot 6 selection and GROUND/B1 chips worked. Zero console errors.
- Git history: authorized T3 handoff and implementation are separate atomic commits. A concurrent untracked `handoffs/M0-T4-session-seam.md` appeared during T3 and was preserved untouched, so repository-wide `git status` is not empty.
