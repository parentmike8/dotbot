# Public quick play and hot-arena foundation

Status: implementation plan for the launch-spine server/protocol lane.

## Ownership boundary

This lane owns the content-neutral path from a public quick-play request to a
reusable authoritative arena:

- additive protocol messages and metadata for public assembly, player roles,
  results, and explicit redeployment;
- one compatibility-keyed public allocation pool in the matchmaker;
- party-preserving assignment into six squads of three;
- authoritative filling of all 18 player roles with humans or explicitly
  labelled player-role AI;
- repeated runs inside one GameLift GameSession and WebSocket connection;
- reconnect grace followed by run-long AI takeover;
- a fresh `matchId` and complete persistence boundary for every run; and
- bounded arena drain/retirement signals that may end the process only between
  runs after persistence settles.

This lane does not own public-screen design, account or durable party systems,
loadout UI, final extraction/content, world authoring, Contract content,
capacity purchases, fleet changes, deployment, or any live AWS mutation.

The existing room-code/host-start implementation remains the rollback path.
Public behavior is additive and selected only by an explicit server/session
mode. The public path does not translate its lifecycle back into fake room
codes or a host.

## State and ownership model

```text
public allocator
  -> selects compatible humans by trusted party, build, and region/latency
  -> GameLift player sessions carry trusted arena/party/build metadata

hot arena
  assembling -- min 1 s, max 6 s --> countdown --> live
      ^                                      |          |
      |                                      |          v
      +---- explicit DEPLOY AGAIN <------- results <----+
                         (after persistence settles)
```

- The matchmaker owns allocation compatibility and reservation metadata. It
  never uses MMR.
- The GameLift adapter owns validation, acceptance, and removal of player
  sessions for the exact assigned GameSession.
- The arena owns admission phase, party-to-squad placement, role fill,
  reconnect/takeover state, and per-run lifecycle.
- Persistence owns the durable transaction for exactly one fresh `matchId`.
  The next run cannot leave results until the previous finish write settles.
- Process retirement is requested by bounded run-count/age policy. The server
  rejects new admissions while retiring; the lifecycle adapter calls
  `ProcessEnding` only after the arena is between runs and persistence is safe.

## Admission invariants

- A party has one to three humans and is never split across squads.
- New humans are admitted only before a run becomes live. Assembly remains
  open through its countdown so reservations accepted inside the bounded
  one-to-six-second window can fill that run.
- Each run has exactly six squads and exactly three player roles per squad.
- Every role is metadata-labelled as `human` or `ai`; ambient grey AI is not a
  player-role substitute.
- A human disconnect freezes that role for reconnect grace. Expiry changes the
  same role to AI for the rest of that run and records the human outcome once.
- Results do not imply consent to queue. `DEPLOY AGAIN` is explicit and queues
  the connected party for the next assembly. When assembly reopens, connected
  parties that did not opt in are released from the arena and their GameLift
  player sessions so replacements can use those roles.

## Retirement and rollback

The public arena stops accepting players when its configured maximum age or
run count is reached. It finishes the current run, waits for all outcome and
match-finish writes, then exposes a safe retirement signal. No per-run code
calls `ProcessEnding`.

GameLift's loopback termination drain requests that same retirement state
before polling `safeToTerminate`. It prevents queued or already-connected
players from starting another run, lets a live run finish, and, if the drain
arrives during an asynchronous match start, settles that exact persistence
boundary before reporting safe. This closes the race where a results or
assembly state could report safe and then advance into a new run.

GameLift player-session removal is also fail-closed without being a retirement
signal. A removal gets three immediate bounded attempts. If all fail, the
server retains the exact terminal reservation binding (including its player
session id and trusted admission metadata), rejects fresh WebSocket admissions,
and reports HTTP 503 readiness with `reservationRemovalDegraded: true`. It does
not disconnect other sockets, stop an unrelated active run, or call
`ProcessEnding`. A different already-bound reservation may still use its
existing reconnect grace, but no fresh GameLift reservation is accepted. The
rejected reservation cannot reconnect while its removal is uncertain. The
server retries the same binding every five seconds; the
first successful adapter response deletes it and restores readiness and
admission automatically. A persistent adapter outage therefore remains
visible to GameLift health handling, while an adapter recovery cannot leave a
healthy non-retiring process permanently admission-bricked. Only the arena's
explicit bounded retirement path may call `ProcessEnding`, after persistence
is safe.

Disabling the explicit public mode leaves the legacy room manager, room-code
protocol, host start, and existing Cloud Run fallback behavior unchanged.
The AWS allocator is also fail-closed: `DOTBOT_PUBLIC_QUICK_PLAY=true` and one
configured `QUICK_PLAY_BUILD_ID` are required before `/quick-play` can create
capacity. Client-supplied build metadata must match that configured compatibility
id; it cannot create arbitrary pool keys. The dedicated server has a separate
default-off `DOTBOT_PUBLIC_QUICK_PLAY` gate, so control-plane and immutable-build
activation must be coordinated deliberately.

## Integration dependency

The identity/GameLift handoff has four deliberately separate responsibilities:

1. `GameLiftSessionGate.acceptPublicPlayerSession` validates and accepts the
   exact reservation for the assigned GameSession and returns its trusted
   player/arena/party/build metadata.
2. `app.ts` keeps that accepted reservation bound to one socket or reconnect
   grace entry. It passes the reservation identity onward unchanged and uses
   it again when a disconnected member must release capacity.
3. `RoomManager.matchesReservedPlayerIdentity` resolves the presented device
   credential to the current canonical account and accepts the reservation id
   only when it is either that canonical id or appears in the server-only
   `PlayerIdentity.previousPlayerIds` alias list.
4. The combined identity integration must preserve its `Room.join` split:
   `resolvedPlayerId` is the formatted public runtime id,
   `persistencePlayerId` is the canonical internal UUID, and that method's
   `previousPlayerIds` argument contains retired formatted runtime ids only for
   duplicate-room admission. The hot-arena merge adds the trusted GameLift
   reservation id as separate private member metadata for exact reservation
   removal. It must not pass `PlayerIdentity.previousPlayerIds` (internal UUID
   aliases) into Room. Retired internal aliases are excluded from arena
   messages, persistence rosters, public identity responses, and directory
   updates.

Arena-directory revisions remain strictly desired-state/session ordered; they
do not depend on player identity or alias lookup completion. An arena may
revise only the exact GameSession/arena tuple first published by the control
plane. It cannot create a missing pointer or reclaim a closed replacement, so
late callbacks cannot produce a directory ABA across concurrent arenas.

The allocator accepts only party metadata returned by the authenticated
control-plane identity response; WebSocket and quick-play request bodies cannot
claim a party. The current control plane does not yet expose a durable party
roster or an atomic multi-member GameLift reservation. Until the identity/social
lane supplies that trusted roster/ticket seam, solo tickets are complete but
atomic whole-party admission across concurrent HTTP requests is not proven.

The server exposes a non-mutating full-roster preflight before admission. An
arena that cannot pack the intact party returns the machine-actionable result
`{ accepted: false, code: "party_composition_full", retryable: true }` and does
not change its membership. The sequential WebSocket fallback also evicts any
provisionally arrived member of that party and sends the same retryable error,
so it cannot silently strand one member. The missing integration step is for
the authenticated matchmaker to call this contract (or an equivalent directory
reservation) with the complete roster before creating any player sessions,
then route the whole party to another assembling arena or create one. This
commit does not claim that cross-arena rerouting is end-to-end complete.
