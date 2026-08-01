# Hot arena and identity/social integration

Status: local integration record, 2026-08-01. Public activation remains off.

## Scope and source order

The integration starts from reviewed local `main` commit `ec2a6585` and replays
the independently accepted stacks in this semantic order:

1. hot-arena foundation `d6fe8f698e8e2d6d03ff9d6ed917ed217d257669`;
2. hot-arena correction `f4768b6154e9625bbccd8bfea6ecf058356ea535`;
3. identity/social foundation `df344244c3a259726cc6d1daf82cbe935a820dfe`;
4. identity/social correction `b250d32e8be78dc7935ae441e89deaf2ef2c686b`.

No push, deploy, public quick-play activation, Firebase resource creation, or
live AWS mutation is part of this work.

## Reproduced conflicts

The two hot-arena commits replayed cleanly. Replaying the identity foundation
then produced content conflicts in:

- `apps/matchmaker/src/handler.test.ts`;
- `apps/server/src/Room.test.ts`;
- `apps/server/src/Room.ts`;
- `apps/server/src/RoomManager.test.ts`;
- `apps/server/src/RoomManager.ts`;
- `apps/server/src/app.ts`;
- `apps/server/src/db/PostgresPersistence.ts`; and
- `apps/server/src/persistence-relay.test.ts`.

These are expected semantic conflicts. They combine public allocation and
multi-run lifecycle behavior with canonical account identity, private aliases,
and endpoint-scoped persistence authentication. They were resolved hunk by
hunk; neither side was selected wholesale.

Replaying the identity correction then produced content conflicts in:

- `apps/matchmaker/src/handler.ts`;
- `apps/server/src/GameLiftSessionGate.test.ts`;
- `apps/server/src/GameLiftSessionGate.ts`;
- `apps/server/src/RoomManager.test.ts`;
- `apps/server/src/RoomManager.ts`; and
- `apps/server/src/app.ts`.

These conflicts were also resolved hunk by hunk. The local semantic replay is:

| Source commit | Local replay commit | Meaning |
| --- | --- | --- |
| `d6fe8f698e8e2d6d03ff9d6ed917ed217d257669` | `4253220d` | hot-arena foundation |
| `f4768b6154e9625bbccd8bfea6ecf058356ea535` | `b96cf5de` | hot-arena correction |
| `df344244c3a259726cc6d1daf82cbe935a820dfe` | `da796d67` | identity/social foundation |
| `b250d32e8be78dc7935ae441e89deaf2ef2c686b` | `103fd593` | identity/social correction |

## Integration plan

1. Preserve the hot-arena state machine, frozen start roster, 18-role human/AI
   fill, reconnect grace, AI takeover, persistence settlement, drain and
   bounded retirement behavior. Preserve fail-closed GameLift removal with the
   retained binding and recovery loop.
2. Layer identity onto admission without changing runtime ownership:
   `resolvedPlayerId` is the formatted public runtime ID,
   `persistencePlayerId` is the canonical Cloud SQL UUID, retired public IDs
   are used only for duplicate-room admission, and retired internal UUIDs are
   accepted only by the server-side GameLift reservation check. Internal UUID
   aliases must never enter Room runtime identity, protocol messages, public
   HTTP responses, or directory revisions; the persistence boundary
   transactionally canonicalizes any in-flight alias before registration.
3. Canonicalize match participant UUIDs transactionally in Postgres while
   retaining the arena correction's 18-participant limit and duplicate-account
   rejection. Keep start, outcome, and finish operations retry-safe and keep
   matchmaker-auth and game-persistence HMAC domains separate.
4. Combine server options and routes additively. Identity account/social routes
   coexist with default-off public quick play, liveness checks remain after
   every awaited admission step, and the legacy room-code path remains the
   feature-off rollback path.
5. Keep arena-directory revisions assigned at call entry and tied only to the
   exact control-plane-published GameSession/arena tuple. Identity resolution
   and aliases cannot allocate, reopen, or advance directory state.
6. Preserve the non-mutating full-party preflight and machine-actionable
   retryable rejection. Do not claim durable roster or atomic multi-member
   allocation until the control plane owns that seam.
7. Merge both test bodies, then add cross-stack regressions for guest allocation
   followed by linking before WebSocket admission, two-device use of one linked
   account, retired-alias reservation, socket close during identity resolution,
   party packing rejection without mutation, reconnect during adapter outage,
   deploy-again/session release, 18-role persistence, HMAC cross-endpoint replay,
   public UUID leakage, and feature-off rollback.
8. Verify on Node 20 with an isolated disposable Postgres database: focused and
   full workspace tests, all typechecks and builds, Go adapter tests (including
   race/vet where available), fresh and upgrade migrations plus an old-writer
   tombstone probe, `git diff --check`, and credential-free SAM/static checks.
   Remove only resources started for this review.

## Conflict decisions and integration hardening

- The Room member keeps a formatted public runtime `playerId` and a separate
  canonical `persistencePlayerId`. Trusted retired internal aliases are passed
  into server-only reservation and duplicate-admission comparisons, while
  retired public IDs support runtime reconnect comparison. No private alias is
  stored as a runtime entity ID or emitted on the public protocol.
- GameLift reservation acceptance retains the hot-arena correction's
  fail-closed uncertain-accept cleanup, bounded immediate retries, retained
  terminal binding, readiness/admission pause, and background reconciliation.
  Identity resolution and every subsequent awaited admission step recheck
  socket liveness before Room mutation; the existing reconnect grace remains.
- Postgres start is one transaction over a frozen run roster. Alias
  canonicalization is combined with the 18-role cap, duplicate canonical-account
  rejection, idempotent start, and requested-ID loadout mapping. Outcomes use
  canonical persistence UUIDs, while finish and aborted-start summaries contain
  only aggregate counts.
- Matchmaker authentication and game persistence retain distinct HMAC domains.
  A signature rejected on the wrong endpoint does not consume its request ID on
  the correct endpoint. Internal errors log safe error names only.
- Arena-directory revisions remain allocated when the desired-state call begins
  and are bound to the exact session/arena/build/region tuple. A stale async
  open cannot advance or reopen a newer closed record.
- Solo party identifiers are stable opaque SHA-256-derived values. Neither the
  matchmaker fallback nor direct/local hot-arena admission embeds a canonical
  UUID in public party data.

## Cross-stack regression coverage

`apps/server/src/hot-arena-identity-integration.test.ts` and the strengthened
GameLift, relay, graceful-degradation, and matchmaker suites cover:

- allocation to a guest followed by account merge before WebSocket admission;
- the same linked account arriving from two devices, including a retired guest
  UUID that now resolves to the canonical account;
- canonical, retired internal, canonical public, and retired public reservation
  matching, with unrelated and blank identities rejected;
- socket close during identity resolution with no ghost Room or member;
- intact-party packing rejection that is retryable and does not mutate Room
  membership;
- reconnect during adapter removal outage and deploy-again/session release;
- all 18 human roles at match start, outcome settlement, and aggregate finish;
- cross-endpoint HMAC replay rejection without cross-domain nonce consumption;
- public HTTP, WebSocket, arena-member, party, and result UUID-leak checks; and
- default-off public quick play with the legacy room-code handshake still live.

## Verification evidence

All JavaScript work ran on Node `v20.20.0` with pnpm `9.15.0`.

- Focused integrated server run: 3 files, 48 tests passed. The matchmaker helper
  suite separately passed 13 tests, and the larger arena/identity focused runs
  also passed before the final workspace run.
- Full disposable-database workspace run: 119 files passed, 1 file skipped;
  1,274 tests passed and 6 tests skipped. Full workspace `typecheck` and
  production `build` passed.
- Fresh migration: Drizzle applied migrations `0000` through `0012` to a blank
  PostgreSQL 16 database. `drizzle-kit check` reported a valid migration graph.
- Upgrade migration: a database at `0008` with a legacy player upgraded through
  `0009`-`0012`; the player received a valid public ID and device-row backfill.
  An old-writer insert omitting all new identity columns received a default
  public ID, and deletion retained exactly one null-target alias tombstone. The
  allocator definition was checked to exclude retired alias IDs.
- GameLift adapter: `go test -race ./...` and `go vet ./...` passed.
- Credential-free static checks: every deployment shell script passed `bash -n`,
  the CloudFormation template parsed as YAML, and the local-parity Compose file
  passed `docker compose config --quiet`. SAM and `cfn-lint` were not installed,
  so no claim is made that those tools ran.
- `git diff --check` passed. The AWS SDK emitted only its announced future
  Node-22 support warning for releases after January 2027; Node 20 completed all
  current checks successfully.

The isolated container was named `dotbot-integration-c312-20260801`, labeled
`dotbot.review-owner=codex-c312-hot-identity`, backed by tmpfs, and removed after
verification. No pre-existing container or process was stopped.

## Activation blockers retained by design

- durable party roster and atomic multi-member allocation/rerouting;
- allocator ownership plus client quick-play, reconnect, cancellation, and
  explicit deploy-again UX;
- live Firebase and AWS configuration/deployment validation; and
- measured 18-client and target-density load testing.

Public quick play remains default-off. This integration did not push, deploy,
create Firebase resources, call live AWS, or mutate any live service.
