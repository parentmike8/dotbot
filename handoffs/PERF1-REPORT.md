# PERF-1 Report: Snapshot slimming

## Result

PERF-1 is implemented and deployed. Dots now establish an interest-filtered, per-viewer baseline at `matchStart`; ordinary snapshots send only changed dot state, and any visible floor-context change sends a wholesale state sync for the affected contexts. Empty collections and default-valued fields are omitted, and dynamic numeric values are rounded on the JSON wire.

The final three six-player load runs measured a maximum of **27,566 B/s per client**, comfortably below the **45 KB/s** exit gate at 20 Hz. The three-run median tick p99 improved from **6.780 ms** to **5.861 ms**. One post-change run recorded an 8.546 ms p99 outlier; it is retained in the table below rather than hidden.

Production revision `dotbot-00007-clm` is serving 100% of traffic at <https://dotbot-jpawns5vla-uc.a.run.app>.

## Wire format

- `matchStart.dotBaseline` contains the complete dot description visible to that viewer: stable id, floor, position, radius, item, active state, and capture progress when nonzero.
- Normal snapshots use optional `dotDeltas`; unchanged dots produce no entry and an empty delta collection produces no JSON key.
- `dotSync` carries context-keyed replacement sets. The client deletes the prior dots for each named context and installs the supplied state wholesale.
- `NetSession` owns the keyed dot store. It seeds from `dotBaseline`, applies ordered TCP deltas, applies wholesale context replacements, and materializes the full dot array consumed by the unchanged renderer and interpolation path.
- The server keeps per-member visible-context and last-sent dot state. Deltas are computed after interest filtering, so clients do not learn that a dot on an invisible floor was captured.
- A new or reconnecting client always receives a fresh viewer-specific baseline; no prior delta history is required.
- Bots remain full-state on every snapshot. No bot delta encoding and no binary encoding were introduced.

## Context-sync design

For each member, the server compares the current visible physics-floor context set to the previously sent set. If equal, it emits only changed visible dots. If different, the same snapshot sends full replacements for the union of old and new contexts: removed contexts are present as a context-only replacement with the empty `dots` field omitted, while newly/currently visible contexts contain their complete dot state. This handles stairs, spectate switches, death, and other view changes without stale dots or information leakage.

## Cheap fat trims

- Snapshot collections such as `mines`, `coverages`, `noises`, `intel`, `dotDeltas`, and `dotSync` are optional and absent when empty.
- Default bot fields are absent on the wire, including Ground floor, zero facing/state/shields, zero velocity and timers, inactive overcharge/incognito state, and empty inventories/radar pings.
- Decoding restores all protocol defaults, so the game/client model remains explicit.
- Bot positions, facing, shields, radar pings, mine/noise/coverage geometry, and other wire floats are rounded to at most two decimals; millisecond progress/timer values are integers.
- Mine privacy and disguise behavior remains in the mines collection, not the dot stream.

## Load measurements

All harness commands used `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm` and `SCENARIO=load PLAYERS=6`. Values below are the six clients in each run, in B/s and average snapshot bytes. Snapshot frequency remained 20 Hz in every run.

| Build | Trial | Per-client B/s | Avg snapshot bytes/client | Tick p99 |
|---|---:|---|---|---:|
| Before | 1 | 117205, 117205, 65412, 118733, 117205, 117205 | 5841, 5841, 3245, 5917, 5841, 5841 | 6.857 ms |
| Before | 2 | 117653, 117653, 117653, 117653, 117653, 117653 | 5851, 5851, 5851, 5851, 5851, 5851 | 6.780 ms |
| Before | 3 | 115811, 115811, 81174, 54857, 115811, 115811 | 5765, 5765, 4033, 2718, 5765, 5765 | 4.699 ms |
| After | 1 | 26591, 26591, 26591, 26591, 26591, 26591 | 1329, 1329, 1329, 1329, 1329, 1329 | 5.861 ms |
| After | 2 | 23963, 23963, 23963, 23963, 25795, 11733 | 1199, 1199, 1199, 1199, 1291, 587 | 8.546 ms |
| After | 3 | 27566, 27519, 27519, 27519, 27519, 27519 | 1376, 1374, 1374, 1374, 1374, 1374 | 4.920 ms |

The old harness labeled its initial aggregate startup counter as `matchStart`; while hardening the measurement, the counter was corrected to record the actual `matchStart` frame. The final viewer-specific match starts were **71,974–71,976 bytes**. This label correction does not affect the sustained B/s or snapshot-size comparison.

The final two-player load run measured:

- matchStart: 71,378 bytes per client
- total: 16,756 B/s per client
- snapshots: 16,747 B/s per client
- average snapshot: 837 bytes
- snapshots: 20 Hz
- tick p99: 5.973 ms

The representative steady-state reduction is about 76% (roughly 115–118 KB/s before to 24–28 KB/s after). All six clients in all final trials remained below the 45 KB/s gate. Comparing three-run medians, tick p99 did not regress.

## Automated verification

All commands used Node 20 binaries. No command connected to host port 5432.

1. `pnpm typecheck` — passed in all workspaces.
2. Stateless `DATABASE_URL` unset, full `pnpm test` — passed:
   - game: 116/116
   - protocol: 16/16
   - client: 20/20
   - server: 9 passed, 7 DB-only skipped
   - total: 161 passed, 7 intentionally skipped
3. PostgreSQL `DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot pnpm test` — passed:
   - game: 116/116
   - protocol: 16/16
   - client: 20/20
   - server: 16/16
   - total: 168/168
4. `pnpm build:all` — client production build and Node 20 server bundle passed. Vite retained its existing large-chunk warning; there were no build errors.
5. Protocol/client coverage — passed:
   - 500 deterministic randomized authoritative-state versus delta-store reconstructions
   - wholesale floor-context replacement, including removed contexts
   - empty/default omission and decoder round-trip
   - `NetSession` baseline, delta, and context-sync application
6. Harness narratives — passed:
   - pacing: WEST GATE insertion, depot reached in 4.075 s, first loot in 6.330 s, extraction in 16.921 s, shelf blueprint and health retained
   - combat: victim downed, plea emitted, loot-then-revive completed in 5.451 s, restored alive at 0.5 shields, mine presentation/disguise behavior intact

A transient server DB-test failure occurred while a separately running local server held concurrent room state. After stopping that server, the full DB suite and an immediate server-only DB rerun passed 16/16.

## Production two-window narrative

The required `./deploy/deploy.sh` completed successfully and deployed Cloud Run revision `dotbot-00007-clm`. The canonical health endpoint returned a live two-member room with tick p99 of 4.131 ms during re-verification.

Two visible production windows used separate test accounts:

- In room `YR75`, both clients joined the same squad, started a run, and inserted at SW YARD. Both rendered the same Ground dot set.
- One client captured an orange health dot through the normal world channel. Its bay count increased from one to two health items, and that dot disappeared immediately in both windows while the adjacent blue dot remained.
- That client then traversed the LOT6 depot stair from Ground to B1. The view switched to the B1 layout and immediately showed B1's complete blue/orange dot set, confirming the full context sync. The other live client remained on Ground with its correct Ground state.
- In an earlier live room, `G8ME`, both clients inserted on different squads, received live snapshots, were downed, chose `GIVE UP`, and both transitioned to `SQUAD WIPED · MAP OVERVIEW`, covering the death/spectate context path.
- Production browser console errors: 0 in both windows.

For isolated two-origin testing, the alternate Cloud Run origin was given a production test account's existing token, and normal keyboard events were injected for sustained movement. No application data or simulation state was modified directly.

## Exit criteria

1. **Typecheck, both DB modes, and production builds:** passed.
2. **Six-player load target and tick health:** passed; maximum 27,566 B/s/client at 20 Hz, with median tick p99 improved. Pacing and combat completed.
3. **Live two-window captures, floor change, spectate, and console:** passed on production with zero console errors.
4. **Deployment and live re-verification:** passed on `dotbot-00007-clm` at the canonical production URL.
5. **Atomic commits and worktree audit:** implementation, reconstruction/measurement tests, and harness hardening are separate commits. No PERF-1 implementation path is uncommitted. The unrelated `handoffs/NET1-motion-smoothing.md` appeared concurrently and remains untracked and preserved, so global `git status` is not empty.

## Binary encoding recommendation

Binary encoding is **not warranted for this milestone**. The measured JSON stream is already well below the 45 KB/s gate, including the worst client across all three final trials. Further work should first profile the remaining full bot payload under larger rooms or adverse movement patterns; only a new measured failure should justify bot deltas or binary framing.
