# Handoff PERF-1: Snapshot slimming — dots as deltas

**Agent brief.** The scripted playtest (`playtest/REPORT.md` §1) measured **115–118 KB/s per client** in a six-player room against a 25–40 KB/s design budget, with byte-identical payloads across clients. The dominant waste: the full dot table (~40 dots) plus always-present empty arrays re-sent 20×/second. This task makes snapshots carry only what changed. Binary encoding stays OFF the table until these wins are measured — the harness decides, not intuition. Single lane, whole repo.

**Preconditions:** UX-1 complete (`handoffs/UX1-REPORT.md`). Production live via `deploy/deploy.sh`. Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432**. The measurement tool is `apps/server/src/playtest/harness.ts` (`SCENARIO=load`).

## 1) Dots become deltas

- `matchStart` already carries the full map; make it (or a one-time first snapshot section) establish the complete dot baseline: id, position, item code, active — everything static.
- Snapshots then carry `dotDeltas` only: dots whose `active` or `captureProgressMs` changed since the viewer's last acked state. During a capture exactly one dot deltas at 20 Hz; most snapshots carry zero.
- **Interest stays intact**: dot deltas remain filtered by the viewer's floor context exactly as dot states are today (a player elsewhere must NOT learn the depot got looted — that information asymmetry is gameplay). Therefore: when a viewer's visible floor-context set CHANGES between snapshots (stairs, spectate switch, death), that snapshot includes a full dot-state sync for the newly visible contexts. The server already computes per-viewer context sets per snapshot — diff them per client.
- Client (`NetSession`): keyed dot store seeded from the baseline, deltas applied in order (TCP ordering makes this safe), context syncs replace wholesale. Renderer reads the store — no renderer changes.
- Reconnect/late-join: the fresh `matchStart` re-baselines; no partial-state hazards.

## 2) Cheap fat trims (same pass, no new machinery)

- Omit empty arrays and zero/default optional fields everywhere in the wire snapshot (`mines: []`, `coverages: []`, `noises: []`, empty `radarPings`, zeroed velocity/overcharge/incognito fields). JSON keys are most of a small message.
- Verify positions/floats are rounded to ≤2 decimals everywhere on the wire (bots, mines, noises, coverage progress → round ms to integers).
- Do NOT delta-encode bots in this pass — measure first; bots are genuinely dynamic and the win is unproven.

## 3) Measure — the exit gate is a number

- Before touching code, run `SCENARIO=load` three times and record the baseline (expect ~115 KB/s per client).
- After: same three runs. **Target: ≤45 KB/s per client at 6 players moving, 20 Hz unchanged.** Report before/after per-client B/s, avg snap bytes, and tick p99 (must not regress).
- Also record the 2-player figure and matchStart payload size.
- If the target is missed, report the numbers and stop — binary encoding becomes its own decision with real data; do not start it inside this task.

## 4) Tests

- Protocol: delta application over a scripted sequence equals the full-state result (property-style: random capture/spawn sequences, delta-applied store === authoritative store); context-change sync delivers exactly the newly visible contexts' dots; empty-array omission round-trips.
- Integration: the existing DB persistence test and harness pacing scenario pass untouched (they read dots from snapshots — update helpers to read the client-store pattern where needed, mechanically).
- Prediction, interest filtering, spectate, mines, radar: existing suites green in BOTH DB modes — the mine disguise rides the mines array, NOT dots; confirm no interaction.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Harness numbers: baseline vs after, target met (≤45 KB/s/client at 6 players) or a stop-report with data; tick p99 not regressed; pacing + combat scenarios still complete.
3. Live, two visible windows: full run with captures — dots vanish correctly on both clients including across floor changes and spectate; zero console errors.
4. **Deploy to production** (`./deploy/deploy.sh`) and re-verify a live run on the production URL.
5. `git status` clean; atomic commits (baseline+deltas / context sync / trims / tests+measurement).

## Report back

`handoffs/PERF1-REPORT.md`: wire format changes, the before/after table, context-sync design, and the recommendation on whether binary encoding is still warranted.
