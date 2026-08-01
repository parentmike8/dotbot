# Public quick-play client and claim contract

Status: activation contract. The feature remains default-off until the control
plane, matchmaker, dedicated server, and client gates are all enabled for the
same build.

## Entry and rollback boundary

The existing grey deployment dot is the only public entry point. Its one-second
stationary channel is unchanged. Channel completion opens deployment and, when
all public gates are present in `/api/game-config`, immediately begins a public
queue claim. There is no confirmation screen, room code, squad picker, or host
start action.

If any public gate or required build/region metadata is absent, deployment uses
the existing private-room lobby unchanged. Public mode is selected only from the
explicit configuration response; a matchmaker URL alone never selects it.

## Client state machine

One opaque operation id fences every asynchronous action. An event carrying a
different operation id is stale and cannot change the current state.

| Phase | Player-visible state | Allowed exits |
| --- | --- | --- |
| `idle` | Base remains authoritative | channel -> `claiming` |
| `claiming` | `ASSEMBLING DEPLOYMENT`, retry/cancel status | allocation -> `connecting`; failure -> `error`; cancel -> `cancelling` |
| `connecting` | arena connection and retry status | arena welcome -> `assembling`, `live`, or `results`; cancel -> `cancelling`; terminal reconnect failure -> `error` |
| `assembling` | intact party, human count, AI fill label, clamped 1–6 second countdown, `CANCEL` | match start -> `live`; cancel -> `cancelling`; connection loss stays in phase with reconnect status |
| `live` | production game renderer and existing mobile controls | run result -> `results`; connection loss stays in phase for the 20-second role grace |
| `results` | manifest, party-preserving `DEPLOY AGAIN`, `SET LOADOUT / RETURN TO BASE` | deploy again -> a *new* `claiming` operation; base -> `idle` |
| `cancelling` | cancellation reconciliation; no match or allocation event can revive the operation | confirmed cancellation -> `idle`; retryable reconciliation failure stays `cancelling`; explicit base return may close only after the server fence is known |
| `error` | accessible error plus `RETRY`, same-reservation `RECONNECT`, or base action | allocation connection retry -> `connecting`; claim retry -> a new `claiming` operation; base -> `idle` |

`DEPLOY AGAIN` is never sent as an in-arena requeue. It creates a fresh HTTP
claim and fresh signed allocation. The durable party survives that boundary,
but the previous claim, loadout snapshot, reservation, and match id do not.
Double channel completion, double deploy, and double retry are idempotent while
an operation is in flight.

The tab stores only a versioned resume envelope in `sessionStorage`: operation
id, connect-or-cancel intent, return-to-base intent, opaque queue ticket, public
arena code, per-member GameLift session id, WebSocket endpoint, party size, and
allocation expiry. It never stores a device token, canonical player UUID,
canonical party UUID, signed roster, or another member's connection. Refresh
reconnects with the same per-member reservation, or continues an in-flight
cancellation without reconnecting; an uncertain allocation is recovered
through queue status before a new claim is created.

## Queue and cancellation authority

Claim creation locks the canonical roster and every canonical player row in a
stable order. In the same Cloud SQL transaction it snapshots each member's
loadout and loadout revision. The signed roster and each signed GameLift
reservation bind:

- claim id, durable party matchmaking key, party version, leader, requester;
- exact canonical member set;
- each member's loadout revision (never the loadout contents);
- build, region, and bounded expiry.

While a claim is `active` or `cancelling`, loadout changes, preset application,
party mutation, account link/merge that would change canonical membership, and
a second incompatible claim fail closed. A member may request cancellation.
Cloud SQL first atomically changes `active -> cancelling`; only then may AWS
cleanup begin. Match start accepts only `active` and changes every participating
claim to `completed` in the same transaction that registers match participants
and consumes the claim-time loadout snapshots. Therefore cancel/start races have
one winner and cannot leave a partial reservation or stale loadout lock.

Cancellation is complete only after GameLift/DynamoDB cleanup and the signed
`cancel-complete` transition. Uncertain cleanup stays visibly retryable and the
Cloud SQL lock remains fenced in `cancelling`; it is never optimistically
unlocked.

## Status, reconnect, and privacy

`POST /quick-play/status` accepts a device token plus an opaque request/ticket.
It returns only the requesting member's allocation or a public state
(`allocating`, `active`, `cancelling`, `cancelled`, `completed`, `expired`). It
does not return canonical UUIDs, roster signatures, another member's session,
or loadout contents. The same authentication, rate-limit, no-store, feature
gate, and canonical/alias checks as create/cancel apply.

The WebSocket always uses `quickPlayHello` in public mode and `hello` in rollback
mode. A reconnect during the 20-second grace resumes the same human role. After
the grace, the server advertises the role as AI-controlled and rejects a stale
client from silently reclaiming it. Player-role AI is explicitly labelled in
assembly/result text and wherever an existing textual player label already
exists; this contract does not add a new world-space visual treatment.

## Failure rules

- A partial or malformed allocation is never connected and is recovered by
  status or cancelled. If the create response is lost and the claim starts in
  the meantime, completed status may return only that member's still-valid
  reservation so the client reconnects instead of opening a second claim.
- A queue timeout fences whole-party cancellation, reconciles AWS and Cloud
  SQL cleanup, and returns to base only after the old claim is terminal. A new
  operation cannot start while that cancellation remains uncertain.
- A stale roster, party version, loadout revision, reservation, match id, or
  response operation id fails closed.
- Network loss never changes loadout/party authority and never autoqueues.
- Results refresh remains results; it does not create a claim.
- Public feature-off means the old private lobby, including room codes and host
  start, remains the rollback path. Those controls are absent from normal public
  mode.

## UI seams deliberately left for visual follow-up

The functional surface uses the existing deployment glass/card/button language
and exposes semantic phase, party view, connection state, countdown timestamps,
AI role labels, error/retryability, and primary/secondary actions. Spacing,
motion, illustration, and any new nameplate treatment remain separate visual
work. No map, building, renderer primitive, base content, catalog, or deployment
dot artwork changes are part of this contract.
