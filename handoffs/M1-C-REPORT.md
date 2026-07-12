# M1-C Completion Report: Run-rules integration + spectate + deploy

## Atomic implementation commits

- `2b982aa` — authoritative protocol and server run rules
- `9b3dfb6` — unified client run state, manifest, and squad spectating
- `38bb8b6` — production bundle and Fly deploy kit
- `c385b12` — LocalSession and full network-loop tests

## Run-state ownership as landed

`GameSession` now exposes one shared `RunState` contract:

```ts
type RunState =
  | { phase: "live" }
  | {
      phase: "over";
      reason: "extracted" | "died" | "timeout";
      keptDots: number;
      lostDots: number;
    };
```

Ownership is deliberately split by session implementation:

- `LocalSession` is the solo authority. It drains simulation events internally, retains those same events for the UI, derives extraction/death outcomes from player-targeted events, and compares local snapshot time with `runDurationMs` for timeout. A consumed event now carries `lostDots`, so death loss no longer depends on a client-side previous-snapshot race.
- `NetSession` never performs local event or time math for run completion. Its state remains live until the server sends `runOver`; reconnect resets at `matchStart` and then accepts the server's replayed `runOver` for an already-finished member.
- `useDotBotGame` is presentation-only. It polls `session.getRunState()`, freezes movement/Dash after transition, creates the manifest view model with the current rendered run time, and continues rendering. It does not inspect extraction/consumption events or compare run duration.
- Kill tallies remain client-side from drained `ev` frames. Solo uses map spawn metadata; network play uses the protocol metadata index so human members and AI wingmates are classified correctly.

## Protocol and authoritative room rules

Added client-to-server:

- `leaveRun {}`

Added server-to-client:

- `runOver { reason, keptDots, lostDots }`

The additive game event is now:

- `consumed { botId, byBotId, lostDots }`

The server drains and processes simulation events every tick, independently of the 20 Hz snapshot cadence:

- Human extraction sends only that member `runOver(extracted)` with the event's exact inventory.
- Human consumption sends only that member `runOver(died)` with the event's captured loss.
- AI/backfill bot extraction or consumption has no member mapping, produces no `runOver`, and cannot crash the room.
- A completed member remains connected as a spectator and continues receiving snapshots and event frames.
- `leaveRun` removes the member and stops their stream; an in-run bot is removed if necessary.
- `endTick = ceil(runDurationMs / tickDurationMs)` is sent in `matchStart`. At that tick the room sends every remaining member `runOver(timeout)` with current inventory loss, then `matchEnd(timeout)` and enters `ended`.
- If extraction, death, or leave removes every human from active play first, the room sends `matchEnd(complete)`.
- Existing all-disconnected teardown remains. A live reconnect restores human control; a reconnecting spectator receives `matchStart` followed by the stored `runOver`.

Network players and their one-person-squad AI wingmates now start with one carried Dot, matching the solo run's initial extraction stake.

## Client manifest and spectate

- The same `ManifestScreen` component renders solo and network outcomes. Its action label is configurable; network play uses `RETURN TO LOBBY`, sends `leaveRun`, closes the session, and returns to the create/join screen.
- After network `runOver`, the hook selects the first living same-squad bot and passes that bot ID to the existing renderer. This preserves viewer-relative cyan/red/grey rendering and LOS behavior without a second spectator renderer.
- `SPECTATING <NAME>` appears above the manifest.
- If no living squadmate exists, the renderer preserves its last viewer/camera instead of falling through to an unrelated bot. Solo keeps its previous fallback behavior.
- The network HUD shows the server-derived countdown. The authoritative transition still comes only from `runOver`, not from the displayed clock.

## Deploy kit

`pnpm build:all` now builds the Vite client and a self-contained Node 20 ESM server bundle at `apps/server/dist/index.js`. The bundle is approximately 3.6 MB. It includes Fastify/WebSocket dependencies and Rapier's base64 `AGFzb...` WASM payload. An ESM `createRequire` banner supports bundled CommonJS dependencies. The final restored bundle boots with plain Node.

Production mode serves:

- built client assets and SPA fallback from `apps/client/dist`
- `/api/health`
- same-origin `/ws`
- `PORT`, default `3001`

Deploy files:

- `deploy/Dockerfile` — `node:20-slim`, production env, only server bundle + client dist, plain-Node command.
- `deploy/fly.toml` — Toronto region, internal port 3001, HTTPS, autostart/autostop, zero minimum machines, shared 512 MB VM.
- `deploy/README.md` — initial and repeat deployment commands.

The owner ships with these exact commands from the repository root, replacing the placeholder app name:

```sh
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm build:all
fly auth login
fly launch --no-deploy --name YOUR_UNIQUE_DOTBOT_APP --region yyz --config deploy/fly.toml --dockerfile deploy/Dockerfile
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

Later releases:

```sh
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm build:all
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

No Fly authentication or deployment was attempted.

## Test coverage

### LocalSession scripted unit tests

Three injected scripted simulations lock ownership at the session boundary:

- `extracted` event → extracted, kept 3, lost 0; the same event remains drainable by UI.
- `consumed` event → died, kept 0, lost 2 from the event payload.
- local snapshot at duration → timeout, kept 0, lost 4 from current player inventory.

### Real WebSocket full-loop integration test

The server test starts an ephemeral Fastify/WebSocket server with a short test configuration, connects Alice and Bob, creates/joins a room, and starts the match. Alice is driven around the depot wall onto the extraction pad and holds the channel. It asserts:

- Alice receives exact `runOver(extracted, keptDots: 1, lostDots: 0)`.
- Alice and Bob continue receiving snapshots after Alice's result.
- an AI wingmate extracts in the middle of the test without a crash or stray member `runOver`.
- Bob reaches `endTick`, receives `runOver(timeout)`, and both clients receive `matchEnd(timeout)`.
- the last snapshot tick is within two ticks of advertised `endTick`.

## Browser verification narrative

### Development mode

Two separate visible Chrome profiles created and joined room `UGUR` through Vite's `/ws` proxy. Both rendered the same authoritative match and countdown. Bob's tab was closed and reopened on `/#/r/UGUR` within the handoff window; it rejoined with the same identity and live state.

For a practical full-loop browser pass, development-only source values were temporarily shortened and hardened, then fully restored without a source diff. Alice walked to the depot pad, received EXTRACTED with KEPT 1 / LOST 0, rendered `SPECTATING ALPHA WING`, and returned to the lobby. Bob continued alone to RUN EXPIRED with KEPT 0 / LOST 1 and `SPECTATING BRAVO WING`. Console errors were empty in both profiles.

### Local production bundle

The Vite-built client and plain-Node server bundle served two visible Chrome profiles from `http://127.0.0.1:3001`. A temporary build-only short-run configuration and alpha verification anchor made the full outcome path deterministic; both were restored afterward and the final normal bundle was rebuilt.

In room `9HG7`, Alice received EXTRACTED with KEPT 1 / LOST 0, spectated the alpha wing, and returned to the lobby while Bob continued receiving snapshots. Bob then received RUN EXPIRED with LOST 1. Both production consoles had zero errors. Fastify also returned HTTP 200 for `/`, served hashed assets, and returned the health payload from `/api/health`.

### Solo mode

The default Vite route loaded the normal M1-A state at 07:59 with three shields and one carried Dot. A browser-only in-memory duration override exercised RUN EXPIRED with LOST 1 and the solo `↻ NEW RUN` action. The override was restored and the remounted run returned to 07:59, three shields, and one Dot. Console errors were empty. Scripted LocalSession tests cover extracted and consumed ownership paths without altering solo gameplay.

## Final verification and exit criteria

1. Automated gates on the restored tree:
   - `pnpm typecheck` — pass across game, protocol, client, and server.
   - `pnpm test` — pass: game 58, protocol 2, client 3, server 1; 64 total.
   - `pnpm build` — pass; server TypeScript and client Vite build, 749 modules.
   - `pnpm build:all` — pass; client plus self-contained 3.6 MB server bundle.
2. Development two-window flow — join/start, live movement/combat, extraction manifest, spectate, return, authoritative timeout, reconnect, and zero console errors all verified.
3. Local production plain-Node bundle — same-origin lobby/WebSocket/full outcome flow, Rapier initialization, extraction, spectate, return, timeout, health/static serving, and zero console errors verified.
4. Solo mode — normal baseline, manifest presentation, new-run remount, and zero console errors verified; all local outcome derivations are unit-tested.
5. The four requested implementation commits are atomic. The supplied handoff is added unchanged with this report documentation commit; final status is clean.
