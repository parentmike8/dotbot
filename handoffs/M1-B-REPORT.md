# M1-B Completion Report: Multiplayer scaffold

## Landed components

Atomic commits:

- `562b670` — protocol and wire mapping
- `2c9377d` — authoritative Fastify/`ws` server and integration test
- `161ed35` — interpolating `NetSession` and client proxy
- `50738ee` — join-code lobby and network game view

## Message schema as landed

Client messages are the requested discriminated union:

- `hello {token, name, roomCode}`
- `startMatch {}`
- `input {seq, move:[x,y], dash}`
- `ping {cts}`

Server messages are:

- `welcome {playerId, roomCode, phase, members, hostId}`
- `lobby {members, hostId}`
- `matchStart {map, config, yourBotId, meta, tickHz, endTick}`
- `snap {tick, ack, bots, dots, coverages, noises}`
- `meta {add, remove}`
- `ev {events}`
- `matchEnd {reason}`
- `pong {cts, sts}`
- `err {code, msg}`

`WireBot` uses only compact dynamics: `i`, `p`, `f`, `fl`, `s`, `sh`, `n`, optional `d`, and optional `iv`. Positions are rounded to 0.01 and facing to 0.001. Static metadata is sent once. `EntityMeta` includes the requested fields plus optional `color`, which is static renderer data required to reconstruct a complete `DotBotEntity`; optionality keeps compatibility with peers that omit it. Mapping exists once in each direction in `wire.ts`. The protocol round-trip test JSON-serializes a synthetic snapshot and verifies the rounding bounds and dynamic/static reconstruction. Both message unions have exhaustive switch coverage.

## Room lifecycle and authoritative server

- One Fastify deployable owns `GET /api/health`, the `/ws` upgrade, and production static-client serving.
- A single process-wide 4 ms interval advances all live rooms. Each room has a real-time accumulator, performs at most five fixed simulation steps per pass, records dropped remainder, and contributes step timings to the rolling p99 health metric.
- Room codes use `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Empty lobby rooms expire after 10 minutes; ended rooms expire after 30 seconds.
- First joiner is host. Players are assigned `alpha`, `bravo`, and `crew-3` round-robin, with four seats per squad and 12 total seats.
- Host start moves `lobby -> countdown` for three seconds, builds the downtown simulation, removes the map's default non-authoritative spawn set, then installs human members at three squad anchors separated by more than 400 px. A one-member squad receives one AI wingmate. Ambient map bots are restored as AI exactly from `map.botSpawns`.
- Latest input is applied per human on every simulation tick; dash is cleared after one application while movement persists. One compact snapshot is built every third tick (20 Hz) and broadcast to all peers, followed by the drained event frame.
- Disconnect switches the member bot to `frozen`, then to `ai` after 15 seconds. A same-token reconnect cancels the handoff if pending, switches the bot to `human`, and resends `welcome` plus `matchStart`. The match ends only when every human connection is gone.
- The integration test boots an ephemeral server, connects two real `ws` clients, creates/joins/starts a room, drives opposing movement and dash input for more than 60 ticks, then asserts both clients receive the same snapshots, both human bots move in their commanded directions, ambient metadata exists, and event traffic reaches both peers.

## Client and lobby

- `NetSession.start()` connects, sends `hello`, and resolves at `matchStart`. It reconstructs snapshots through the protocol metadata index and exposes the received map/player through `GameSession`.
- Input is coalesced and sent at most every second render frame (approximately 30 Hz at 60 fps). Dash remains sticky until an input frame is actually transmitted.
- The snapshot ring retains 20 samples. Render time is newest tick minus 100 ms (six ticks at 60 Hz). Bot positions use linear interpolation and facing uses shortest-arc interpolation between bracketing snapshots. Shields, state, dots, coverages, noises, and all other non-positional values come from the older bracket.
- The lobby persists a 128-bit random device token and display name in local storage. Blank room code creates; four-character code joins. `/#/r/CODE` preloads and, when an identity exists, automatically reconnects. The lobby shows assigned squads and exposes START only to the host.
- The network game view uses the existing renderer without changes, sends keyboard/touch-dash input through `NetSession`, and keeps the default solo and `?studio` routes unchanged.

## Bandwidth sample

An actual full-room wire snapshot with the downtown ambient population measured 6,295 bytes as uncompressed JSON. At 20 Hz that is approximately 126 KB/s per connected client before WebSocket deflate. `perMessageDeflate` is enabled above 512 bytes, so repetitive dot/entity keys compress on the live wire; compressed socket bytes were not separately instrumented in this milestone.

## Parallel-lane rebase adjustments

The M1-A lane landed four commits while this work was in progress:

- `582796d` removed snapshot banking fields and added the `extracted` event. The protocol mapper and synthetic test were adjusted to the reduced `GameSnapshot`; event forwarding is union-driven and required no per-event server branch.
- `8644aa6` added run lifecycle/manifest client work and the new config field. Server and network types consume the complete config mechanically, so no hand-copied field list changed.
- `523c762` changed revive shield behavior. No network change was needed because shield segments are dynamic wire data.
- `775cc35` changed relationship rendering. No M1-B renderer file was touched.

Immediately before final verification, `git rebase 775cc35` reported `Current branch main is up to date.` The M1-A commits are ancestors of the final M1-B commits, and there were no ownership-zone conflicts.

## Exit criteria verification

1. Automated checks after the rebase:
   - `pnpm typecheck` — pass across game, protocol, client, and server.
   - `pnpm test` — pass: game 58/58, protocol 2/2, server integration 1/1.
   - `pnpm build` — pass: server TypeScript build and client production Vite build.
2. Visible two-client test with `pnpm dev:all`:
   - Vite served on 5174 because an existing process owned 5173; its `/ws` proxy reached the server on 3001.
   - Visible client A created room `G5BQ` as Alice. A second visible Chrome client opened `/#/r/G5BQ`, joined as Bob, appeared in A's lobby as `bravo`, and saw Alice as host/`alpha`.
   - Alice started. After the three-second countdown both windows rendered the same authoritative downtown world with their own player, AI squadmate, and ambient/rival population. Combat proceeded; Bob's HUD dropped from three shields to one while both clients continued receiving state.
   - Dash was clicked in both windows. Both rendered the dash movement/noise rings. Map collision, plates/combat, fog/LOS, and ambient movement continued without client divergence.
   - Bob's window was closed. After 16.2 seconds it was reopened on the same URL/profile. Bob rejoined the live match with the same identity; his location had migrated from Main Street to the Civic/North Pad area during the disconnect, demonstrating the frozen-to-AI handoff. Clicking Dash immediately after reconnect rendered a fresh ring, confirming control returned to the human client.
   - Console warnings/errors: none in either client before or after reconnect.
3. Rebase is documented above and was performed before all verification in this section.
4. Component commits are atomic. The final documentation commit includes the provided handoff and this report; final status is clean.
