# Handoff NET-1: Motion smoothing — interpolation buffer, prediction blending, transport hygiene

**Agent brief.** Production playtesting shows severe visual jitter: bots (own and remote) jump forward/back, and collisions feel mistimed. Measured cause (scripted probe against the live Cloud Run URL, 20s of continuous play): snapshot inter-arrival p50 = 49.3ms (nominal 20Hz) but **p90 = 92ms, p99 = 139ms, max = 194ms, with 50 sub-15ms burst arrivals and 33 stalls >100ms in 399 snapshots; RTT ≈ 74ms**. The transport (Cloud Run proxy + TCP) delivers snapshots in stall-then-burst clumps. Rendering "latest snapshot" (or lerping toward it) under that pattern produces exactly the observed symptoms. The fix is presentation-layer netcode: a fixed-delay interpolation buffer for remote entities, bounded correction blending for the predicted own bot, and transport hygiene. Single lane, whole repo. **Sequencing: after PERF-1 — both rework `NetSession` and the snapshot path.**

**Preconditions:** PERF-1 complete (`handoffs/PERF1-REPORT.md`). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432**. Production deploys via `./deploy/deploy.sh`.

## 1) Instrument first — the netgraph (permanent tooling)

Extend the F3 debug overlay with a netgraph: snapshot inter-arrival sparkline + p50/p90/p99, RTT (existing ping/pong), interpolation buffer depth, own-bot prediction error (px), and corrections applied per second. Every later judgment in this task is made with this overlay on, against PRODUCTION. Keep it in the shipped build behind F3 — feel bugs get diagnosed in the field from now on.

## 2) Remote entities: fixed-delay interpolation buffer

- Snapshots must carry the server tick (add it to the wire if PERF-1 didn't); the client syncs a server-clock estimate via the existing ping/pong.
- Remote bots, mines, coverages, and noises render at `renderTime = estimatedServerTime − interpolationDelayMs` (default **125ms** ≈ 2.5 snapshot intervals; config knob), interpolating position/facing between the two bracketing buffered snapshots. Burst arrivals just fill the buffer; stalls up to the delay window are invisible.
- Buffer under-run (stall > delay): extrapolate remote motion for at most ONE snapshot interval, then hold position; on recovery, re-converge smoothly (no teleports — cap correction speed).
- Dot capture rings, channel progress, and radar pings ride the same delayed timeline so everything on screen is mutually consistent.
- Own squad HUD (bays, plates) may read the freshest snapshot — inventory is not motion.

## 3) Own bot: bounded reconciliation, never rubber-banding

- Keep prediction + input replay from the acked seq (M2 design). Fix the correction step: apply server error as an exponential blend with a per-frame cap (knobs; suggest ~30%/frame capped at 6px, snap only beyond ~150px for teleports/respawns). The predicted bot must never visibly move BACKWARD along its own path during normal play.
- Verify the predictor models the server's input latching exactly (Room applies the member's `latestInput` every tick between input frames — the client must replay under the same assumption; a mismatch here manifests as steady-state error and constant corrections).
- The netgraph's prediction-error series is the acceptance instrument: steady-state error while running straight on production should sit near zero with corrections rare.

## 4) Transport hygiene (measure each change with the probe before/after)

- Try disabling `permessage-deflate` — post-PERF-1 snapshots are small, and per-message compression adds latency variance; keep it only if the probe shows no jitter win.
- Confirm the server sends each snapshot immediately (no cork/batch in the ws write path).
- The probe script pattern lives in this handoff's history: connect a ws client to production, record snap inter-arrival p50/p90/p99/bursts/stalls over 20s of continuous input. Reproduce it as `apps/server/src/playtest/jitterprobe.ts` so it's a permanent tool, and put before/after numbers in the report.

## 5) Collision feel (scope boundary)

With remotes on a coherent delayed timeline and the own bot smoothly predicted, visual/authoritative disagreement drops to ~RTT/2 + delay — bumping an AI should look right. NO server-side lag compensation in this pass: if hit-feel is still wrong after the presentation fix, report specifics (with netgraph numbers) and stop — rewind-based compensation is its own decision.

## 6) Tests

- Interpolation: pure functions over scripted snapshot sequences — bursty arrival timings produce monotonic smooth output positions; under-run extrapolation caps at one interval; recovery never teleports.
- Prediction blending: correction stays within per-frame caps; large-error snap path; latching-semantics replay parity (drive the real sim and the predictor with identical input streams — positions must match within float tolerance).
- Existing suites green in BOTH DB modes; harness pacing/combat/load scenarios still pass.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Probe numbers recorded before/after transport changes; netgraph screenshots on production showing buffer depth ≥1 sustained and prediction error near zero in straight-line motion.
3. Live, two visible windows ON THE PRODUCTION URL: remote bots glide (no teleporting) while the netgraph shows the measured burst/stall pattern still present at transport level; own bot never visibly rubber-bands; walking into an AI bot looks like contact at contact.
4. **Deploy** (`./deploy/deploy.sh`) is part of the task; the live narrative happens on the deployed build.
5. `git status` clean; atomic commits (netgraph / interp buffer / prediction blend / transport / tests).

## Report back

`handoffs/NET1-REPORT.md`: netgraph design, buffer/blend parameters chosen and why, transport before/after probe table, replay-parity test results, and an honest verdict on remaining hit-feel issues (if any) with data.
