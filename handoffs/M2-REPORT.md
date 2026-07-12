# M2 Completion Report: Feel and fairness

## Atomic implementation commits

- `225e250` — export shared static collision helpers
- `dd17f64` — add the local-bot fixed-step predictor and unit tests
- `d51fb2f` — integrate own-bot prediction and reconciliation into `NetSession`
- `54de780` — add pure per-viewer interest filtering, server integration, and bandwidth health
- `2526249` — add spectate cycling and run-clock sanity checks

## Own-bot prediction as landed

Prediction is deliberately limited to the network player's own bot: position, facing, floor, and dash timers. Remote bots, dots, coverages, noises, combat, channels, and stairs remain authoritative/interpolated. There is no whole-world rollback or re-simulation.

- Fixed step: `1000 / config.tickHz` (60 Hz with the shipped config).
- Movement: normalized input using the shared game math, `playerSpeed` while walking, `dashSpeed` while dashing.
- Dash: timers decrement before the press is considered, matching the simulation. A press during cooldown is consumed on that tick and is never retained. Replayed dash input is applied on the first replay tick only.
- Static collision: shared `collectSolidRects` and `separateCircleFromRect` helpers; three separation passes and map-bound clamping. Prediction intentionally omits bot-vs-bot collision.
- Pending log: exact `{ seq, input }` for commands actually sent. Snapshot `ack` removes every entry with `seq <= ack`.
- Replay: reset a scratch local prediction to the authoritative own-bot state, then apply each unacknowledged 30 Hz command for two 60 Hz ticks. The second replay tick always has `dash: false`.
- Correction thresholds:
  - error `< 0.5 × botRadius`: adopt corrected state immediately and silently;
  - error from `0.5 ×` through `3 × botRadius`: reset to corrected state and decay the rendered positional offset over 100 ms;
  - error `> 3 × botRadius`: snap outright.
- Own-bot rendering replaces the interpolated local entity every frame. Other entities retain the existing 100 ms interpolation delay.
- Authoritative floor changes bypass replay/blending, adopt the server bot wholesale, clear correction offset, and reset the predictor accumulator.
- `LocalSession` was not changed.

Unit coverage locks straight-line distance against config speed/tick rate, dash no-banking, acknowledgement removal plus two-tick replay, and adopt/blend/snap boundaries.

## Interest filtering and health

`filterForViewer` is a pure protocol function over the one wire snapshot built per server broadcast. It selects from those existing arrays; the simulation snapshot is not rebuilt per member. Static entity metadata remains lobby-wide and unfiltered.

Implemented rules:

- Active viewer bots: every same-squad bot on every floor, plus bots on the viewer's current physics floor.
- Spectators: every same-squad bot plus bots on physics floors occupied by living squadmates. Noise listeners are living squadmates on those visible floors, allowing local spectate cycling without a new client/server targeting message.
- Dots: visible physics floors only.
- Coverages: visible physics floor, or an included actor/target bot.
- Noises: included only when shared `classifyNoise` says an applicable viewer/squad listener perceives the noise, retaining loudness, wall, and stair-floor leakage semantics.
- Events: subject bot or `byBotId` is included or belongs to the viewer squad.
- Snapshot acknowledgement is per member rather than the former room-wide maximum.

`/api/health` now includes `roomHealth: [{ code, bytesPerSecond, members }]`. Bytes count the JSON payload after per-viewer filtering and before WebSocket deflate, including empty event frames. Each room logs one bandwidth summary every 30 seconds.

Bandwidth measurements:

- Deterministic default-map snapshot sample: 13 bots / 6,201 bytes unfiltered versus 7 bots / 2,493 bytes for the outdoor player, a 59.8% per-snapshot reduction.
- Live two-member room `ZNES`: 18,611 bytes/second aggregate after filtering. During the B1 wallhack check, the moving viewer's bot array dropped from 9 to 3.
- Eight-member stress/spectate room health reached roughly 237–303 KB/s aggregate post-filter while all streams were active.

## Small riders

- While a run is over, Space queues a cycle through living same-squad bots.
- The visible `SPECTATING <NAME>` chip is now a button above the manifest; tapping it performs the same cycle.
- `NetSession` retains `endTick` and, in development only, warns once if the countdown derived from `snapshot.timeMs` differs from `(endTick - tick)` by more than two ticks. No warning fired during browser verification.

## Browser verification

### Prediction feel and dash parity

Two independently visible clients ran in the in-app browser and Chrome so neither render loop was background-suspended.

- Before M2, the local bot necessarily used the 100 ms interpolation buffer plus snapshot/frame cadence, roughly 120–150 ms input-to-rendered-motion.
- After M2, the own bot moved from the local predictor on the next render/fixed step. Coarse development snapshot instrumentation (updated only every 80 ms) observed keyboard-driven position change after 56 ms; visual response was within one frame and no longer tracked the remote interpolation delay.
- A valid Dash moved the predicted player 96 px and showed authoritative cooldown on the next sampled frame.
- A second press during cooldown was dropped. Position remained exactly `669.59, 893.34` after dash motion settled and through cooldown expiry; no delayed dash fired.

### Interest and stairs

In visible room `ZNES`, the player was keyboard/button-driven through the Lot 6 depot stair at approximately `(818, 1,100)`:

- authoritative floor changed `outdoor → lot6:B1`;
- no rubber-banding loop or stuck state occurred;
- the predictor accepted the floor reset cleanly;
- the received bot array dropped from 9 to 3;
- street enemies disappeared;
- `enemy-6` on `lot6:B1` remained;
- the consumed alpha squadmate remained listed on `outdoor`, demonstrating the cross-floor teammate rule.

### Spectate cycling

A final visible two-browser run used six inert/local WebSocket peers so two squadmates remained available at run completion. The server used a temporary in-memory verification config passed to `createServer`; no source file was edited. At timeout:

- the chip initially showed `SPECTATING ORBIT 2`;
- tapping the chip changed it to `SPECTATING ORBIT 5`;
- pressing Space changed it back to `SPECTATING ORBIT 2`.

### Regression routes and consoles

- Solo route initialized to Explore with three shields, one carried Dot, and its normal controls.
- Map Studio rendered its building selection, layer controls, and canvas normally.
- Multiplayer, solo, and Map Studio console error logs were empty. The existing Rapier initialization deprecation remained a warning only.

## Final verification and exit criteria

1. Node 20 full gates on the implementation tree:
   - `pnpm typecheck` — pass across game, protocol, client, and server.
   - `pnpm test` — pass: game 59, protocol 7, client 7, server 1; 74 total.
   - `pnpm build` — pass.
   - `pnpm build:all` — pass; Vite client and 3.6 MB server bundle.
   - A final server typecheck/test rerun after bandwidth accounting cleanup also passed.
2. Two visible development clients — join/start, local prediction, instant Dash, no-banking, filtered snapshots, cross-floor teammate retention, and zero console errors verified.
3. Depot GROUND→B1 stair transition — verified without a correction loop or stuck state.
4. Tap and Space spectate cycling — verified against two living squadmates.
5. Solo route and Map Studio — verified unchanged with zero console errors.
6. The five requested implementation commits are atomic. The supplied M2 handoff is added unchanged with this report commit.
7. M2-owned changes are fully committed. `handoffs/M3-persistence.md` was already present as an unrelated untracked future-task handoff and was preserved without staging or modification, so the repository-wide status is not literally empty.
