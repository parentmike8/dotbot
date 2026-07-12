# Handoff M2: Feel & fairness — own-bot prediction, interest filtering, polish

**Agent brief.** Networked DotBot currently renders YOUR own bot through the same 100ms interpolation delay as everyone else, so input feels floaty; and every client receives the entire world state, so a modified client could see through walls. You are fixing both: client-side prediction for the local bot, and per-viewer interest filtering on the server. Single lane — you own the whole repo. Architecture authority: `dotbot-implementation-roadmap.md` (Prediction and Interest mgmt rows). **Never rollback/re-simulate the full world on the client — that approach is explicitly banned.**

**Preconditions:** M1 complete (`handoffs/M1-C-REPORT.md`; suite currently 65 tests across 4 packages, all green). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Browser verification requires VISIBLE windows (hidden windows suspend rAF and freeze the loop).

## Part 1 — Own-bot prediction (`apps/client/src/game/prediction/`)

**Scope of prediction: the local player's bot ONLY — position, facing, dash timers. Nothing else.** Remote bots, dots, coverages, noises keep the existing interpolation path untouched.

- `LitePredictor`: fixed 60Hz stepping using `GameConfig` constants (`playerSpeed`, `dashSpeed`, `dashDurationMs`, `dashCooldownMs`, `tickHz`). Movement = same normalize/scale as the sim. Dash fires only if the predicted cooldown is ready and the press is consumed on the tick it is considered — **mirror the no-banking rule just added to the sim (`applyHumanIntents` in `packages/game/src/simulation.ts`, commit a6e24f9)** so predicted and authoritative dash decisions agree.
- Collision: circle-vs-rect against the bot's current floor solids. Do NOT duplicate the math — export the existing `separateCircleFromRect` from `packages/game/src/simulation.ts` (move it to `packages/game/src/math.ts` or a new `collision.ts` with a re-export) and add a small exported `collectSolidRects(map, physicsFloorId)` helper (walls + `isSolidObject` objects for that physics floor; remember GROUND floors share the outdoor plane — reuse `physicsFloorId`). No bot-vs-bot collision in prediction; reconciliation absorbs it.
- `NetSession` integration: pending input log `[seq, input]`; the server's `snap.ack` already reports the last applied seq. On each snapshot: take the authoritative own-bot state, drop inputs ≤ ack, replay the remainder through the predictor (inputs are sent at ~30Hz against a 60Hz sim — apply each pending input for two predicted ticks; approximate replay is FINE, do not chase exactness, blending absorbs residual error).
- Error blending: if |replayed − predicted| < 0.5 × botRadius, adopt silently; otherwise blend the rendered position toward the corrected one over ~100ms; snap outright only beyond 3 × botRadius. Facing snaps with input (it's local intent).
- Rendering: own bot renders from the predictor every frame; the interpolated own-bot from the buffer is ignored. Floor changes (stairs) are NOT predicted — when the server says the bot changed floors, adopt server state wholesale and reset the predictor (a one-tick hitch on stairs is acceptable and invisible).
- Channels stay server-driven (already correct). Solo `LocalSession` is untouched — prediction lives entirely in the net path.
- Unit tests (`apps/client`): predictor steps match sim constants (a straight-line run of N ticks lands within ε of `speed × N/tickHz`); dash no-banking parity (press during predicted cooldown is dropped); replay-after-ack drops acknowledged inputs; blend thresholds behave (adopt / blend / snap).

## Part 2 — Interest filtering (`packages/protocol/src/interest.ts` + server)

Per-viewer world trimming, computed server-side from the one wire snapshot built per broadcast (keep the build-once discipline; filtering must not re-clone the world per member — filter by selecting from the built arrays).

- `filterForViewer(wire, meta, viewerCtx)` — pure function, unit-testable. `viewerCtx` = the viewer's squadId + the set of physics-floor ids their squad's living bots occupy (server computes it per member per broadcast; for a spectator whose own bot is gone, the squad set alone drives it).
- Include rules:
  - **Bots**: same physics floor as the viewer's own bot, PLUS every same-squad bot regardless of floor (teammate markers), PLUS nothing else. (Outdoor + all GROUND floors are one physics floor already — `physicsFloorId` semantics.)
  - **Dots / coverages**: same physics floor as the viewer's own bot; coverages also included when actor or target is an included bot.
  - **Noises**: reuse the sim's loudness/floor-leak semantics — include a noise if `classifyNoise` (from `@dotbot/game/mapModel`) says the viewer's bot would perceive it. Spectators use their spectated squadmate's position.
  - **Events (`ev`)**: include when the subject bot (or `byBotId`) is an included bot or same-squad. Kill tallies still work because kills you cause are by definition near you.
  - `meta` stays unfiltered (names/squads are lobby-known anyway).
- Unit tests: same-floor included / different-floor excluded / squadmate-always / noise leak through floors per loudness / coverage follows its bots / spectator context.
- Server health: extend `/api/health` with per-room `bytesPerSecond` (post-filter, pre-deflate is fine) and member count. Log a one-line per-room bandwidth summary every 30s.

## Part 3 — Small riders

- **Spectate cycling**: while spectating, Space / tap cycles among living squadmates; the `SPECTATING <NAME>` chip updates.
- **Clock sanity**: assert (dev-only console warn) if `snapshot.timeMs`-derived countdown and `endTick` disagree by more than 2 ticks.

## Hard constraints

- Interpolation params, run-state ownership, manifest logic, revive/combat rules, solo mode: unchanged. `packages/game` edits limited to the collision-helper export (+ its import updates). No new deps. Docs/handoffs untouched except your report.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`, `pnpm test` (all existing + your new predictor/interest tests), `pnpm build`, `pnpm build:all` pass.
2. Two VISIBLE windows, dev mode: own bot responds to input within one frame (drive with keyboard; the rendered bot must move immediately, not ~120ms later — compare against a remote bot's view of you, which still interpolates); dash feels instant and never banks; walking into a building removes street enemies from the OTHER client's `window.__dotbotSnapshot` (assert bots array shrinks — this is the wallhack test) while squadmates stay listed across floors; spectate cycling works after death.
3. Stairs under prediction: walk a full stair transition (e.g. depot GROUND→B1) — brief correction is acceptable, no rubber-banding loop, no stuck states.
4. Solo route and Map Studio unchanged; zero console errors everywhere.
5. `git status` clean; atomic commits (collision export / predictor / netsession integration / interest / riders).

## Report back

`handoffs/M2-REPORT.md`: predictor parameters as landed (blend thresholds, replay strategy), measured before/after input-to-motion latency (rough), filter rules as implemented + measured bandwidth delta, stair-transition behavior notes, verification output.
