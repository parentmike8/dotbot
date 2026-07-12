# Handoff M1-C: Run-rules integration + spectate + deploy — closing milestone M1

**Agent brief.** M1-A gave the game its extraction run loop (solo) and M1-B gave it an authoritative multiplayer scaffold (rooms, snapshots, lobby). You are fusing them: the server becomes the owner of run rules in networked play, players get manifests and spectate over the wire, and the whole thing runs in production mode so friends can playtest. This is a single-lane task — you own the whole repo, but change A/B internals only where integration requires.

**Preconditions:** `handoffs/M1-A-REPORT.md` and `handoffs/M1-B-REPORT.md` exist; suite is 61 tests green. Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Browser verification requires VISIBLE windows (Chrome suspends rAF in hidden windows — the game will look frozen).

## 1) Run-state ownership (the subtle integration point — read twice)

Today M1-A's client hook ends a run by watching drained events AND `snapshot.timeMs >= runDurationMs`. In networked play the SERVER must be the only authority, or a client whose clock/tick view drifts will double-fire or early-fire run-over. Restructure:

- `GameSession` gains: `getRunState(): RunState` where `RunState = { phase: "live" } | { phase: "over"; reason: "extracted" | "died" | "timeout"; keptDots: number; lostDots: number }`.
- **LocalSession** computes it internally by MOVING M1-A's existing hook logic (event watching + timeout comparison) into the session. Same behavior, new home.
- **NetSession** sets it exclusively from a new server message — never from local time math.
- The hook consumes `getRunState()` uniformly and keeps only presentation (freeze input, show manifest). Kill-tally logic stays where A put it (client-side from `ev` frames — identical in solo and net).

## 2) Protocol + server run rules

- Add S2C `runOver { reason: "extracted" | "died" | "timeout"; keptDots: number; lostDots: number }` and C2S `leaveRun {}` to `packages/protocol`.
- Room, on drained events each tick:
  - `extracted` for a HUMAN member's bot → send that member `runOver { reason: "extracted", keptDots: event.inventoryDots, lostDots: 0 }`.
  - `consumed` for a human member's bot → `runOver { reason: "died", keptDots: 0, lostDots: <inventory at death — capture it from the event payload; if the sim's consumed event lacks the count, extend the event in packages/game with `lostDots` (additive change, update its test)> }`.
  - Events for AI-controlled non-member bots (backfill wingmates extract/die too) must be handled without a member mapping — no send, no crash.
- Room-owned timer: at `endTick` (already sent in `matchStart`), every member still in-run gets `runOver { reason: "timeout", keptDots: 0, lostDots: <current inventory> }`, then `matchEnd { reason: "timeout" }`; phase → ended.
- `matchEnd` also fires when every human member has extracted/died/left (reason `"complete"`) — keep the existing all-disconnected teardown.
- After `runOver`, a member may stay connected (spectate; keep sending them snapshots/ev) or send `leaveRun` → stop their streams, drop membership; their bot is already gone/consumed.

## 3) Client: manifest + spectate over the wire

- Manifest screen (A's component) renders identically in net play, fed by `getRunState()` + client kill tallies. The `↻ NEW RUN` action in net mode becomes `RETURN TO LOBBY` (back to the lobby/room screen; a fresh run = host starts a new match or creates a new room — keep it minimal).
- **Spectate v1:** after runOver in net mode, behind the manifest overlay keep rendering; camera follows the first LIVING same-squad bot (pass that bot's id as the render `playerId` so the existing viewer-relative rendering just works). No living squadmates → keep last camera position. Add a small `SPECTATING <NAME>` HUD chip. Solo mode: unchanged (no spectate — the world freezes under the manifest as today).
- Countdown in net mode already works off `snapshot.timeMs` (server-derived); verify it matches `endTick` within a tick or two and leave the authoritative trigger to the server.

## 4) Production mode + deploy kit

- Server: when `NODE_ENV=production`, serve `apps/client/dist` statically (B scaffolded this — finish/verify it), same origin for `/ws` + `/api`. Config via env: `PORT` (default 3001).
- Build pipeline: root script `build:all` = client build + server esbuild bundle (`--bundle --platform=node --format=esm`, self-contained output in `apps/server/dist/`). Verify the bundle boots with plain `node` and Rapier WASM works (it inlines as base64).
- `deploy/` dir: `Dockerfile` (node:20-slim, copy server bundle + client dist, `CMD node ...`), `fly.toml` (single process, internal port from env, `min_machines_running = 0` is fine), and `deploy/README.md` with the exact `fly launch/deploy` commands for the owner to run (you cannot authenticate to Fly — do NOT attempt to deploy; the local prod verification below is your proof).
- Local prod verification: `build:all`, run the bundle with `NODE_ENV=production`, open TWO visible browser windows on `http://localhost:3001`, complete a full networked run.

## 5) Tests

- Extend the server integration test into the full loop (use a test `GameConfig` with short `extractionDurationMs` and small `runDurationMs`): two clients join/start; drive client A onto an extraction pad and hold the channel → A receives `runOver {reason:"extracted"}` with correct `keptDots`, B keeps receiving snapshots; then let the room hit `endTick` → B receives `runOver {reason:"timeout"}` and both receive `matchEnd`. Assert AI-wingmate extraction mid-test causes no crash/no stray `runOver`.
- Unit-test `RunState` derivation in `LocalSession` (extracted / died / timeout paths) with a scripted sim — this locks A's moved logic in place.
- Whole suite green; game-package tests untouched except the additive `consumed.lostDots` change if needed.

## Hard constraints

- No new gameplay features (no pleas, no loot-then-revive, no insertion preferences — later milestones). No dep additions beyond esbuild if not already present. Don't touch `dotbot-*.md` docs, `handoffs/` (except your report), Map Studio, or solo-mode behavior beyond the LocalSession refactor in §1.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:all` all pass.
2. Dev mode, two VISIBLE windows: full run — join by code, start, fight; one player extracts on a pad → manifest with kept count → spectates the squadmate → leaves to lobby; other player rides to timeout → RUN EXPIRED manifest; reconnect-during-match still works; zero console errors.
3. Prod mode locally (`node` bundle, port 3001): the same full-run flow works served from the bundle.
4. Solo mode (`pnpm dev`, default route) still plays exactly as after M1-A, including its manifest paths.
5. `git status` clean; atomic commits (protocol+server rules / client runstate+spectate / deploy kit / tests).

## Report back

`handoffs/M1-C-REPORT.md`: run-state ownership as landed (who triggers what, exactly), protocol messages added, spectate implementation notes, deploy kit contents + the exact commands the owner runs to ship to Fly, full-loop test narrative (dev and prod), verification output.
