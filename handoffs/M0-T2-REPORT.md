# M0-T2 completion report

## Final public API

`DotBotSimulation` now exposes:

- `static create(options): Promise<DotBotSimulation>`
- `spawnBot(spawn, controller): string`
- `removeBot(botId): void`
- `setController(botId, controller): void`
- `applyInput(botId, input): void`
- `step(): void`
- `getSnapshot(): GameSnapshot`
- `drainEvents(): SimEvent[]`
- `dispose(): void`

The existing `readonly config`, `readonly map`, and `setMeasuredFps(fps)` instrumentation remain public. Controllers and per-bot inputs are internal maps. Initial player-team spawns are human-controlled; every other initial spawn is AI-controlled. Frozen bots have zero movement while retaining collision bodies. Dash requests remain queued until consumed by a valid human-bot dash.

`GameSnapshot` no longer contains `map`, `playerId`, or `locationLabel`. The client owns the map/player identity and computes location labels from snapshot position data.

## Event emission sites

- `downed`: `damageBot`
- `consumed`: `consumeBot`
- `revived`: `reviveBot`
- `dotCaptured`: `resolveDotCapture`
- `dotsBanked`: `resolveExtraction`

`drainEvents()` returns the queued events and clears the queue. Events are absent from snapshots and do not participate in simulation decisions.

## Deviations

- Retained the existing public `setMeasuredFps`, `config`, and `map` members because the client still supplies FPS debug instrumentation and removing those existing members was not part of snapshot slimming.
- Duplicate `spawnBot` IDs throw instead of overwriting an existing bot and leaking its Rapier objects. Duplicate-ID behavior was otherwise unspecified.

No gameplay, tuning, team-based speed, AI targeting, map content, shield logic, renderer drawing, or Map Studio behavior changed.

## Tests and verification

- Before: 4 files, 52 tests.
- After: 4 files, 56 tests.
- Added coverage: independent human controllers, mid-run removal cleanup, frozen solid-body behavior, and downed/revived/consumed event draining.
- All original assertions remain unchanged except the required mechanical `applyInput("player", input)` call updates. The determinism digest and expectations are unchanged.
- `pnpm typecheck`: passed for game and client.
- `pnpm test`: 4 files passed; 56 tests passed.
- `pnpm build`: passed with Vite 8.0.16; 739 modules transformed. Existing large-chunk warning remains.
- Browser game route: joystick movement, dash, AI combat, restart, HUD, location label, and floor rail verified. Location changed from `DOWNTOWN` to `LOT 6 DEPOT / GROUND`; the GROUND/B1 rail rendered. Existing revive behavior is covered by the unchanged simulation test plus the new event test. Zero console errors.
- Browser Map Studio route: rendered unchanged; building selection and floor chips worked. Zero console errors.
- Git history: authorized T2 handoff, implementation, and report are separate atomic commits. All T2 changes are committed. A concurrent untracked `handoffs/M0-T3-squad-refactor.md` appeared during T2 and was preserved untouched, so repository-wide `git status` is not empty.
