# Handoff M3: Persistence + identity — Postgres, accounts, the hold, manifest history

**Agent brief.** Runs currently evaporate: extracted dots vanish at match end and identity is a throwaway localStorage token. You are adding the persistence layer: real (anonymous) accounts, a hold that accumulates extracted dots between runs, and manifest history — with the cardinal rule that **extraction manifests are written AT extraction time in one transaction, never at match end**; a server crash mid-match must not eat a successful extract. Architecture authority: `dotbot-implementation-roadmap.md` (Persistence row + M3).

**Preconditions:** M2 complete (`handoffs/M2-REPORT.md` exists, suite green). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. If M2 is not merged and green, stop and report.

## 0) Graceful degradation — the load-bearing design rule

The server must run **with or without a database**. On boot: if `DATABASE_URL` is unset or unreachable, log one clear warning and run exactly as today (stateless rooms, client-generated tokens accepted). Every persistence call site goes through a `Persistence` interface with a real Postgres implementation and a no-op fallback. This keeps `pnpm dev` zero-friction, keeps the Fly deploy working before a managed Postgres exists, and keeps all pre-M3 tests meaningful without a DB.

## 1) Infra (owner-visible steps — document, don't assume)

- `docker-compose.yml` at repo root: `postgres:16-alpine`, port 5432, named volume, `POSTGRES_DB: dotbot`.
- Root scripts: `db:up` (`docker compose up -d postgres`), `db:migrate` (drizzle-kit migrate), `dev:db` = db:up + migrate + dev:all.
- Default `DATABASE_URL=postgres://postgres:postgres@localhost:5432/dotbot` via `.env` (add `.env.example`; `.env` gitignored).
- **OWNER STEPS you must document prominently in your report:** Docker Desktop must be running for `db:up`; production needs a managed Postgres (`fly postgres create` + `fly postgres attach`) — write the exact commands into `deploy/README.md` as a new section but DO NOT run them.
- New deps allowed (only these): `drizzle-orm`, `drizzle-kit`, `postgres` (the driver).

## 2) Schema (Drizzle, `apps/server/src/db/`)

Create all five now (migration churn is worse than dormant tables); M3 actively uses the first four:

```
players            (id uuid pk default, display_name text, device_token_hash text unique, created_at, last_seen_at)
hold_items         (id uuid pk, player_id fk, item_type text, qty int, acquired_match_id uuid null, acquired_at)
match_results      (id uuid pk, room_code text, map_id text, started_at, ended_at null, summary jsonb null)
match_participants (match_id fk, player_id fk, outcome text, extracted_manifest jsonb null, pk(match_id, player_id))
learned_blueprints (player_id fk, blueprint_id text, learned_at, pk(player_id, blueprint_id))   -- dormant until M4
```

## 3) Accounts (device-token, anonymous)

- `POST /api/auth/register {name}` → `{playerId, token}`: generates a 128-bit token server-side, stores `sha256(token)`, returns plaintext once. `POST /api/auth/hello {token}` → `{playerId, name}` for session resume; updates `last_seen_at`.
- Client lobby: on first use (or when the stored token is unknown to the server), call register and REPLACE the current client-generated token in localStorage (same keys: `dotbot.playerName`, `dotbot.deviceToken`). Existing flow otherwise unchanged.
- WS `hello`: when persistence is live, resolve the token to the `players` row and attach `playerId` to the member (unknown token → register-on-the-fly with the offered name; never reject a friend at the door). Without DB: exactly today's behavior.

## 4) Persistence hooks (Room)

- Match start: insert `match_results` row (id = uuid, `started_at`); keep the id on the Room.
- On a member's `runOver(extracted)`: **one transaction** — insert `hold_items` (`item_type: "dot"`, `qty: keptDots`, `acquired_match_id`) + upsert `match_participants` (`outcome: "extracted"`, `extracted_manifest` jsonb = the runOver payload). This write happens the moment extraction resolves — NOT at matchEnd.
- `runOver(died|timeout)` → upsert participant outcome only. `leaveRun`/disconnect-forever → `outcome: "disconnected"` if no prior outcome.
- `matchEnd` → best-effort update `match_results` (`ended_at`, `summary` jsonb: per-member outcomes). Failures here must not crash teardown.
- AI-controlled bots never touch the DB.

## 5) Client surfacing (minimal, title-block aesthetic)

- `GET /api/profile` (token header) → `{name, holdDots, recentManifests: last 10 of {roomCode, outcome, keptDots, lostDots, endedAt}}`.
- Lobby screen: a small `HOLD: N DOTS` line under the name, and a compact `RECENT RUNS` list (outcome + kept). Nothing fancier.
- Explicitly out of scope: withdrawing hold dots into a run, bays/hold gameplay, blueprints — that's M4. The hold is a one-way bank for now; say so in a UI hint if natural.

## 6) Tests

- Persistence tests skip cleanly when `DATABASE_URL` is absent/unreachable (`describe.skipIf`) so the suite passes on machines without Docker.
- With DB (you should run them locally): register → ws hello resolves identity; full-loop integration extended: extract → assert `hold_items` + `match_participants` rows exist WHILE the match is still live (this is the crash-safety property, prove it by asserting before `matchEnd`); died/timeout outcomes recorded; profile endpoint returns the accumulated hold across two matches.
- No-DB mode: boot server without `DATABASE_URL`, run the existing M1/M2 integration test unchanged — must pass.

## Hard constraints

- No gameplay changes of any kind. No auth beyond device tokens (no passwords/emails/OAuth). Fly/DB provisioning documented, never executed. Docs/handoffs untouched except your report + the `deploy/README.md` section.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`, `pnpm test` (with AND without `DATABASE_URL`), `pnpm build:all` pass.
2. Live with DB (`pnpm db:up && pnpm db:migrate`, then dev): two visible windows, full run where one player extracts carrying dots → their lobby shows the hold incremented and the run in RECENT RUNS after RETURN TO LOBBY; kill the server process immediately after the extraction manifest appears and confirm the `hold_items` row survived (psql or a script).
3. Live without DB: server boots with the warning, rooms/matches work exactly as M2 left them.
4. Solo route and Map Studio untouched; zero console errors.
5. `git status` clean; atomic commits (infra+schema / accounts / room hooks / client surfacing / tests).

## Report back

`handoffs/M3-REPORT.md`: schema as landed, the Persistence interface seam, exact owner steps (Docker locally; Fly Postgres commands added to deploy/README.md), crash-safety test narrative, verification output for BOTH modes.
