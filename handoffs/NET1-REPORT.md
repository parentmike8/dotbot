# NET-1 Report: motion smoothing

## Result

NET-1 is implemented and deployed. Production is serving Cloud Run revision `dotbot-00015-prv` at <https://dotbot-jpawns5vla-uc.a.run.app/> with 100% traffic.

The transport still arrives in the same stall-then-burst pattern identified by the handoff, but remote presentation now rides a server-tick interpolation timeline and the predicted own bot reconciles without ordinary backwards corrections. In the final production two-window run, both clients sustained a one-or-more snapshot buffer for normal play. A representative F3 reading during movement was `Snap 48/111/140ms`, `RTT 67ms`, `Buffer 1 @ 125ms`, `Error 0.0px`, `Corrections 0/s`.

No server-side lag compensation was added.

### Production follow-up: local navigation cadence and diagonal line

A user playtest after the initial rollout exposed two presentation defects that the first live narrative missed:

- local prediction advanced correctly at 60 Hz, but the rendered own-bot position used only the last completed fixed step. On displays whose frames did not align perfectly with simulation ticks, that presented a held frame followed by a larger step;
- concealed-mine and radar arcs reused Pixi's current drawing path, allowing Pixi to draw a long connector from earlier geometry to the mine.

Revision 15 renders a non-mutating partial-tick preview between the predictor's current and next fixed states. The fixed predictor, reconciliation, and replay semantics remain unchanged. The preview is monotonic through ordinary movement and dash expiry and lands exactly on the next fixed state. Mine seams and segmented radar/incognito marks now begin isolated paths, eliminating the diagonal connector.

## Netgraph

F3 now permanently toggles a shipped network overlay in both solo and multiplayer runs. It reports:

- the last 64 snapshot inter-arrival samples as a sparkline;
- inter-arrival p50/p90/p99;
- ping/pong RTT;
- interpolation delay and current buffer depth;
- authoritative-versus-predicted own-bot error in pixels;
- reconciliation corrections applied in the last second.

The overlay is off by default. `?netgraph=1` is retained as a production-QA convenience and survives lobby/base route replacements; F3 remains the user-facing toggle. On revision 14, F3 was exercised in a live multiplayer run and the graph disappeared on the first press and returned on the second.

## Remote interpolation

Snapshots are buffered with their authoritative server tick. Ping/pong carries server time and tick so the client maintains a server-clock estimate. Rendering uses:

`renderTick = estimatedServerTick - 125ms`

The chosen parameters are:

| Parameter | Value | Reason |
| --- | ---: | --- |
| Interpolation delay | 125 ms | Covers roughly 2.5 nominal 20 Hz snapshot intervals and the common observed stall window. |
| Maximum extrapolation | 50 ms | One snapshot interval, then hold rather than inventing continued motion. |
| Recovery speed cap | 1,000 px/s | Re-converges after an under-run without a recovery teleport. |

Remote bot position/facing, mines, noises, channel coverage progress, dot capture progress, radar timers, and radar-ping age use the same delayed timeline. Own-squad bays and plates continue to use the newest authoritative snapshot. Render tick is monotonic, so an arrival burst cannot move presentation time backwards.

The pure interpolation tests cover monotonic output under bursty delivery, one-interval extrapolation followed by hold, and capped recovery.

## Own-bot reconciliation

The predictor replays from the acknowledged sequence with the same input-latching rule as `Room`: the newest input remains active on every server tick until another input arrives, while edge-triggered actions such as dash are consumed once.

Normal corrections use a 30% exponential blend capped at 6 px per animation frame. Errors above 150 px snap, which is reserved for actual teleports/respawns. Errors below 0.5 px are adopted without a visible correction. A forward-path guard removes any correction component that would visibly move the bot backwards along its current input direction.

The parity test drives the real `DotBotSimulation` and `LitePredictor` with the same latched input stream for 12 ticks, including a direction change and dash. Position matches to four decimal places, facing to five, and dash timing to four.

## Transport probe

`apps/server/src/playtest/jitterprobe.ts` is now the permanent 20-second production probe. It creates a disposable two-player room, drives both clients continuously, records inter-arrival and RTT percentiles, and reports the negotiated WebSocket extension.

| Production trial | p50 | p90 | p99 | max | <15 ms bursts | >100 ms stalls | RTT p50 / p90 | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| NET-1 baseline, compression on | 48.0 ms | 90.2 ms | 141.2 ms | 160.7 ms | 47 | 34 | 113 / 144 ms | Baseline |
| Compression disabled | 49.0 ms | 93.5 ms | 146.3 ms | 219.7 ms | 50 | 36 | 74 / 144 ms | No jitter win; rejected |
| Final transport trial, compression restored + TCP no-delay | 48.9 ms | 90.5 ms | 135.7 ms | 243.9 ms | 58 | 37 | 73 / 147 ms | Kept |
| Revision 14 post-deploy recheck | 47.7 ms | 112.8 ms | 138.1 ms | 143.4 ms | 83 | 58 | 62 / 144 ms | 399 snapshots; buffer hides the delivery variance |

The compression experiment did not improve p90/p99 or stalls, so `permessage-deflate` remains enabled with the existing 512-byte threshold. TCP no-delay is explicitly set on upgraded sockets. Snapshot writes remain immediate—there is no application-level cork, batching queue, or delayed flush in the peer send path.

## Automated verification

All commands used the Node 20.20.0 binaries. Postgres testing used `127.0.0.1:55432`; port 5432 was not used.

| Gate | Result |
| --- | --- |
| `env -u DATABASE_URL pnpm test` | Passed: 170 tests; 7 expected DB-only skips |
| `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/dotbot pnpm test` | Passed: all 177 tests |
| `pnpm typecheck` | Passed across game, protocol, client, and server |
| `pnpm build:all` | Passed: Vite client and Node 20 server bundle |
| Harness pacing | Passed; extracted in 19.207 s with shelf blueprint + health retained and 0.04 timer remaining |
| Harness combat | Passed; down, plea, loot-then-revive, sensor pings, disguised mine, and victim recovery all observed |
| Harness load, 6 players | Passed; 24,305 B/s/client total, 24,297 B/s/client snapshots, 20 Hz, tick p99 4.707 ms |
| Predictor/interpolation unit coverage | Passed, including real-simulation latching parity and all correction/under-run limits |

## Production narrative

The exact deployment command was `./deploy/deploy.sh`. Cloud Run confirmed follow-up revision `dotbot-00015-prv` as both the latest-ready revision and the 100%-traffic revision.

Two visible production windows joined room `JFB7` as separate players on separate squads. Both received the same live run, and both multiplayer views rendered the F3 netgraph. The graph showed the real burst/stall pattern rather than a synthetic local profile: one client sampled `48/113/147ms` with `140ms` RTT and the other sampled `43/121/297ms` with `139ms` RTT during startup. Each held a 125 ms interpolation buffer with depth 1–2, while prediction error remained 0.0–0.2 px and corrections remained 0/s.

During the two-window motion pass, the remote bot advanced monotonically through the other player's view with no backwards step or recovery teleport despite uneven snapshot arrivals. Straight-line own input remained visually forward-only and the F3 error settled at 0.0 px with 0 corrections/s. In the live contact pass, shield damage/downing began when the rendered bots met; no repeatable early or late collision was observed. The automated combat narrative also completed at the same authoritative contact boundary.

## Hit-feel verdict and remaining limitation

Contact now looks like contact at the point damage begins, and neither own nor remote movement showed the former forward/back rubber-band. I did not find a remaining hit-feel defect that justified stopping the presentation fix or opening lag-compensation scope.

The remaining limitation is transport-level variance: production still commonly delivers snapshots in bursts after 100+ ms stalls, and a 125 ms presentation delay is an intentional latency tradeoff. The F3 graph makes that condition visible. If a future playtest reports hit-feel problems, capture the live F3 p90/p99, buffer depth, prediction error, and corrections/s first; rewind-based server compensation remains a separate product decision.

## Commits

- `abe0321` — permanent F3 network graph
- `b2cf725` — server-tick remote interpolation buffer
- `6c00551` — bounded own-bot reconciliation and latch parity
- `f6e4dd9` — permanent jitter probe and transport hygiene
- `191f45a` — production-QA netgraph route preservation
- `1ab1a47` — multiplayer netgraph rendering
- `a21d063` — partial-tick own movement and isolated renderer arcs
