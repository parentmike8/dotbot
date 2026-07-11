# Handoff M1-B: Multiplayer scaffold — protocol, server, NetSession, lobby

**Agent brief.** You are building the first real multiplayer path: a Node game server that runs the existing simulation authoritatively, a wire protocol, a `NetSession` client, and a join-by-code lobby. Success = **two visible browser windows on one machine/LAN join a room and fight in the same world.** Architecture authority: `dotbot-implementation-roadmap.md` (Locked architecture decisions + M1). Build against the CURRENT sim API exactly as it stands — a parallel lane (M1-A) is reworking run rules; integration happens in a later task (M1-C), so design your seams accordingly and expect to rebase.

**Parallel-lane rules (M1-A works in this repo simultaneously):**
- YOUR ownership zone: `packages/protocol/**`, `apps/server/**` (new), `apps/client/src/game/session/NetSession.ts` + `createSession.ts`, new lobby UI files under `apps/client/src/ui/lobby/`, `apps/client/src/main.tsx`, `apps/client/vite.config.ts` (proxy), root `package.json` scripts, workspace file.
- DO NOT touch: `packages/game/**` (read-only dependency — you may NOT edit `types.ts`; if you need a type that doesn't exist, define it in `packages/protocol`), `apps/client/src/game/renderer/**`, `useDotBotGame.ts`, `App.tsx`, `styles.css` beyond appending clearly-marked lobby styles at the end.
- Before your FINAL verification and report: `git pull/rebase` onto the latest M1-A commits and re-run everything. Expect `GameSnapshot` field changes (banking fields removed, an `extracted` event added) — your wire layer should tolerate additive/subtractive snapshot changes with minimal edits (map fields mechanically, don't hand-copy field lists in many places).

**Preconditions:** M0 complete (`handoffs/M0-T4-REPORT.md`, 58 tests green). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. **Browser verification requires visible windows** (Chrome suspends rAF in hidden windows; the game will look frozen otherwise).

## Sim facts you build on (do not modify them)

`@dotbot/game`: `DotBotSimulation.create({map, config})` (async), `spawnBot(spawn: BotSpawn, controller: "human"|"ai"|"frozen"): string`, `removeBot(id)`, `setController(id, c)`, `applyInput(botId, {move:{x,y}, dash})` (dash sticky until consumed; inputs only accepted for human-controlled bots), `step()` (fixed tick, `config.tickHz` = 60), `getSnapshot()`, `drainEvents()`, `dispose()`. `BotSpawn` needs `squadId`, optional `isAmbient`/`controller`. Map/config from `@dotbot/game/content/downtown` + `@dotbot/game/config`. Rapier WASM inits fine in Node (vitest proves it).

## 1) `packages/protocol`

- `messages.ts` — discriminated unions:
  - C2S: `hello {token, name, roomCode}` · `startMatch {}` (host) · `input {seq, move:[x,y], dash}` · `ping {cts}`.
  - S2C: `welcome {playerId, roomCode, phase, members, hostId}` · `lobby {members: {playerId, name, squadId}[], hostId}` · `matchStart {map, config, yourBotId, meta: EntityMeta[], tickHz, endTick}` · `snap {tick, ack, bots: WireBot[], dots, coverages, noises}` · `meta {add, remove}` · `ev {events}` · `matchEnd {reason}` · `pong {cts, sts}` · `err {code, msg}`.
  - `EntityMeta` = per-bot statics sent once: `{id, name, squadId, isAmbient, maxShields, radius}`. `WireBot` = dynamics only: `{i, p:[x,y], f, fl, s, sh, n, d?, iv?}` with positions rounded to 0.01, facing to 0.001.
- `wire.ts` — `toWireSnapshot(snapshot)` / `fromWireSnapshot(wire, metaIndex): GameSnapshot` (reconstructs full entities client-side). Keep the field mapping in ONE place each direction. No interest filtering yet (full room state).
- Unit tests: round-trip a synthetic snapshot through toWire→JSON→fromWire and assert positional error ≤ rounding; message-type exhaustiveness.

## 2) `apps/server`

- Single deployable: Fastify (routes: `GET /api/health` → `{rooms, tickP99Ms}`; in prod serve `apps/client/dist` statically) + bare `ws` on the same HTTP server at `/ws`, `perMessageDeflate: {threshold: 512}`.
- `RoomManager`: `createRoom()` → 4-char code (unambiguous alphabet, no 0/O/1/I); `join(code)`; rooms die after 10min empty lobby or 30s post-match.
- `Room` phases `lobby → countdown(3s) → live → ended`:
  - Lobby: members join via `hello` (token = client-generated random string; name from client). First member = host. Squad assignment: fill squads `alpha`, `bravo`, `crew-3` round-robin, cap 3 squads (players per squad ≤ 4). Broadcast `lobby` on change. `startMatch` only from host.
  - Match start: `DotBotSimulation.create` with the downtown map/config; for each member `spawnBot({...spawn template, squadId}, "human")` using spawn positions spread across the existing extraction-pad/streets areas with ≥400px spacing between squads (hardcode 3 squad anchor points; exact spots your choice on open street). AI backfill: if a squad has fewer than 2 members, add 1 AI squadmate (`controller:"ai"`, same squadId). Ambient bots: spawn `map.botSpawns` entries that are `isAmbient` as-is. Send `matchStart` (map+config+meta) then begin ticking.
  - Tick loop: one process-wide `setInterval(4ms)`; each room accumulates real time and steps 0..5 sim ticks (cap 5; if behind, drop the remainder and count it in health). Apply latest-received input per human per tick. Every 3rd tick: build ONE wire snapshot, send to every member. Forward `drainEvents()` as `ev` each broadcast.
  - Disconnect: keep the bot, `setController(botId, "frozen")`, 15s grace → `setController(botId, "ai")`. Reconnect with same token within the match → back to `"human"`.
  - `matchEnd`: for now, only when all humans disconnect (run-rules integration is M1-C).
- Keep `Room` free of transport specifics where easy (methods take/return plain messages) — M1-C will exercise it in tests.
- Integration test (vitest, in `apps/server`): boot server on an ephemeral port, connect two `ws` clients, join same room, start, send opposing inputs for ~60 ticks, assert both receive snapshots, the two bots' positions diverge per their inputs, and `ev` traffic arrives. This test is the heart of the task — make it solid.

## 3) Client: `NetSession` + lobby

- `NetSession implements GameSession` (interface in `apps/client/src/game/session/GameSession.ts` — read it, don't modify it): `start()` connects WS + completes `hello`; resolves on `matchStart` (constructs map/config/playerId from the message). `sendInput` → `input` frames at most every other rAF (~30Hz), with `seq`. `update(elapsedMs)` interpolates: keep a snapshot ring buffer; render at (newest tick − 100ms) by lerping bot positions/facing between the two bracketing snapshots; non-lerped fields (shields, states, coverages, noises, dots) come from the older bracketing snapshot. `drainEvents` returns events received since last call. `dispose` closes the socket.
- `createSession`: add the `"net"` branch (`{kind:"net", url, roomCode, name, token}`).
- Lobby UI (`apps/client/src/ui/lobby/`): minimal, matches the drafting aesthetic (paper/ink variables): name field (persist to localStorage with a generated token), CREATE ROOM / join-by-code field; in-room member list with squads + START (host only); joining via URL `/#/r/CODE` works. On `matchStart`, swap to the game view running on the NetSession.
- `main.tsx` routing: `?studio` → Studio (unchanged) · `#/r/CODE` or lobby state → lobby/net game · default → current solo game (untouched path).
- `vite.config.ts`: dev proxy `/ws` (ws:true) and `/api` → `http://localhost:3001`. Root scripts: `dev:server` (tsx watch), `dev:all` (concurrently client+server). Do not change plain `pnpm dev`.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`, `pnpm test` (game suite untouched-green + your protocol/server tests), `pnpm build` all pass.
2. Live: `pnpm dev:all`; two VISIBLE browser windows: window A creates a room, B joins by code, host starts; both spawn, see each other move in real time, dash works, plates/combat/LOS behave; a rival AI is visible to both consistently. Kill window B → its bot freezes then goes AI within ~15s; reopen with same token → control returns. Zero console errors both sides.
3. Rebased onto latest M1-A before final verification; note every rebase adjustment in the report.
4. `git status` clean; atomic commits per component (protocol / server / client-net / lobby).

## Report back

`handoffs/M1-B-REPORT.md`: message schema as landed, room lifecycle implementation notes, interpolation parameters chosen, bandwidth observed (rough), rebase adjustments, verification output including the two-window test narrative.
