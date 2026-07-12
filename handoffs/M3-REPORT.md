# M3 Completion Report: Persistence and identity

## Atomic implementation commits

- `cca0a19` — Postgres infrastructure, Drizzle schema/migration, dependencies, and persistence seam
- `190c638` — anonymous device-token HTTP accounts and WebSocket identity resolution
- `e664159` — match lifecycle and extraction-time room persistence hooks
- `de72733` — hold/profile endpoint and compact lobby surfacing
- `550983f` — stateless fallback and Postgres integration tests

## Graceful degradation as landed

Every database call site goes through the injected `Persistence` interface. `Room`, `RoomManager`, WebSocket handling, and HTTP handlers do not import Drizzle or the Postgres driver.

`createPersistence()` implements the load-bearing boot rule:

- `DATABASE_URL` unset: log one clear warning and return `NoopPersistence`.
- URL configured and reachable: probe with `select 1`, log the successful connection, and return `PostgresPersistence`.
- URL configured but unreachable: close the failed driver, log one clear fallback warning, and return `NoopPersistence` instead of failing startup.

The no-op implementation retains the M2 token-based room identity shape, accepts existing client-generated tokens, returns an empty hold/profile, and makes match persistence calls harmless. If a live Postgres identity lookup later fails, WebSocket hello falls back to the stateless identity rather than rejecting the player. Match-start, outcome, disconnect, and match-end write failures are caught and logged without stopping simulation or teardown.

The `Persistence` contract owns:

- player registration, resume, and register-on-WebSocket-hello;
- token-authenticated profiles;
- match start;
- transactional extraction settlement;
- died, timeout, and disconnected outcomes;
- best-effort match completion;
- connection shutdown.

## Infrastructure and schema

Added:

- `docker-compose.yml`: `postgres:16-alpine`, host port 5432, `dotbot` database, health check, and named `dotbot-postgres` volume.
- `.env.example`: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/dotbot`.
- local ignored `.env` with the same development default.
- root scripts: `db:up`, `db:migrate`, and `dev:db`.
- allowed dependencies only: `drizzle-orm`, `drizzle-kit`, and `postgres`.
- Drizzle config and generated migration `apps/server/drizzle/0000_next_magik.sql`.

Five tables landed:

1. `players`
   - UUID primary key with server default
   - display name
   - unique SHA-256 device-token hash
   - created and last-seen timestamps
2. `hold_items`
   - UUID primary key
   - player foreign key
   - item type and quantity
   - nullable acquired-match foreign key
   - acquired timestamp
3. `match_results`
   - UUID primary key
   - room code, map ID, started timestamp
   - nullable ended timestamp and JSONB summary
4. `match_participants`
   - composite match/player primary key
   - outcome
   - nullable JSONB extraction manifest
5. `learned_blueprints`
   - composite player/blueprint primary key
   - learned timestamp
   - intentionally dormant until M4

## Accounts and identity

- `POST /api/auth/register { name }` creates a server-side 128-bit token, stores only its SHA-256 hash, and returns `{ playerId, token }` once.
- `POST /api/auth/hello { token }` resolves an existing account and updates `last_seen_at`.
- Unknown WebSocket tokens are registered with the offered display name when Postgres is live; no friend is rejected for arriving with an old token.
- Known WebSocket tokens resolve to the stable UUID player ID and stored name.
- The lobby calls hello for an existing local token, registers and replaces it when unknown, and falls back to a legacy client-generated 128-bit token if the auth endpoint cannot be reached.

## Extraction-time transaction and room hooks

At match start, `Room` generates the UUID match ID, inserts `match_results`, and retains the ID.

Extraction settlement occurs when the simulation emits `extracted`, not at match end:

1. The member is stopped immediately and the run result is retained in room state.
2. One Drizzle transaction inserts the `hold_items` dot quantity and upserts the `match_participants` row with outcome `extracted` and the complete runOver JSON manifest.
3. Only after that transaction settles does the server send `runOver(extracted)` to the client.

This ordering means seeing the EXTRACTED manifest is proof that the bank transaction completed. It never rolls back or waits for `matchEnd`.

Other hooks:

- died and timeout upsert participant outcomes;
- leave and post-grace disconnect record `disconnected` only when no prior outcome exists;
- once a disconnected member is handed to AI, that bot is persistence-ineligible;
- AI-only bots have no player/member mapping and never write to the database;
- match end waits for pending participant writes, broadcasts the existing message, then best-effort updates `ended_at` and a per-player outcome summary;
- outcome summaries retain members that already left the room.

## Profile and lobby UI

`GET /api/profile` accepts `x-device-token` or a Bearer token and returns:

```json
{
  "name": "Persist One",
  "holdDots": 2,
  "recentManifests": [
    {
      "roomCode": "9AQD",
      "outcome": "extracted",
      "keptDots": 1,
      "lostDots": 0,
      "endedAt": null
    }
  ]
}
```

The lobby adds a title-block-style `HOLD: N DOTS` line, the explicit one-way-bank/M4 hint, and the ten most recent outcomes with kept-dot counts. It refreshes on initial lobby load, after account establishment, and immediately after returning from a run.

Withdrawing hold dots, hold/bay gameplay, and blueprint use remain out of scope for M3.

## Owner steps

### Local Postgres

Docker Desktop must be running. From the repository root:

```sh
cp .env.example .env
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm db:up
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm db:migrate
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm dev:all
```

Or use the combined startup:

```sh
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm dev:db
```

During verification, host port 5432 was already occupied by the user’s long-running `covet-postgres` container. It was left untouched. M3 database tests instead used an isolated temporary `postgres:16-alpine` container on host port 55432. The required checked-in compose configuration remains port 5432.

### Fly managed Postgres

These exact commands were added to `deploy/README.md`. They were documented only and were not executed:

```sh
fly postgres create --name YOUR_DOTBOT_DB --region yyz
fly postgres attach YOUR_DOTBOT_DB --app YOUR_UNIQUE_DOTBOT_APP
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

## Crash-safety proof

### Automated

The Postgres full-loop test registers Alice through HTTP, resolves the same UUID through WebSocket hello, and performs two real extractions. Immediately after each `runOver(extracted)` and while the partner keeps the room phase `live`, it asserts:

- no `matchEnd` has arrived;
- the room is still live;
- one matching `hold_items` row exists;
- one `match_participants(outcome = extracted)` row exists.

It then proves partner timeout persistence, directly verifies a died outcome, and checks `/api/profile` returns two accumulated hold dots and two extracted manifests.

### Visible live process-kill check

Two independently visible clients registered `Persist One` and `Persist Two` and joined room `TZLU` against Postgres 16. `Persist One` extracted one dot and returned to a lobby showing:

- `HOLD: 1 DOTS`
- recent run `extracted`
- `KEPT 1`

A second run used room `9AQD`. When the EXTRACTED manifest appeared, the server process was stopped immediately without sending match end. A direct `psql` query after process death returned:

```text
Persist One|2|2|t|t
```

That is two hold rows totaling two dots, both participant outcomes extracted, with the crashed `9AQD` match still having `ended_at IS NULL`. The successful extract survived exactly the failure mode M3 is designed for.

## Stateless and regression verification

- A server started with no `DATABASE_URL` emitted exactly one fallback warning.
- An existing token opened room `DVDE`, a second stateless peer joined, and the normal M2 match reached the live HUD with three shields and the standard eight-minute clock.
- The stateless lobby displayed an empty hold/history without blocking rooms.
- The unchanged M2 WebSocket integration test passed in this mode.
- Solo loaded at Explore with three shields and one carried dot.
- Map Studio rendered its normal building and layer controls.
- Multiplayer, solo, and Map Studio browser console error lists were empty.

## Final verification and exit criteria

1. Precondition after `e2d28ac`: full M2 suite green, including all 59 game tests.
2. Without `DATABASE_URL`:
   - full `pnpm test` passed: 76 tests passed and the one DB-only test skipped cleanly;
   - existing M2 server integration passed unchanged;
   - absent and unreachable database fallback tests passed.
3. With `DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot`:
   - full `pnpm test` passed: 77 tests across all packages;
   - all four server tests ran and passed.
4. Final tree:
   - `pnpm typecheck` passed across game, protocol, client, and server;
   - `pnpm build:all` passed; client build plus 3.9 MB server bundle.
5. Visible Postgres hold/history, process-kill survival, visible stateless match, solo, Map Studio, and zero console errors were verified.
6. The five requested implementation commits are atomic. The supplied M3 handoff is added unchanged with this report commit.
