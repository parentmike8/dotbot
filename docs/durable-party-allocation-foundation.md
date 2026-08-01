# Durable party roster and atomic public allocation

Status: implementation contract, 2026-08-01. Both activation gates remain off by default.

This document closes the durable-party and whole-roster allocation blocker without defining party UI, loadout UI, world content, Contracts, equipment content, or fleet capacity.

## Authority and activation

- Cloud SQL owns the canonical party, its ordered membership, its current leader, the membership version, invite lifecycle, and the active queue claim.
- The matchmaker owns compatibility selection, arena-directory packing reservations, the idempotent allocation record, and GameLift player-session creation or compensation.
- The dedicated arena owns a non-mutating full-roster preflight and verifies allocation metadata before accepting any player session.
- `DOTBOT_DURABLE_PARTIES=true` enables the durable control-plane APIs. With it off, the existing invite-acceptance behavior remains the rollback path and the new party routes return 404.
- `DOTBOT_ATOMIC_PARTY_ALLOCATION=true` enables the versioned-roster allocator and dedicated-server verification. It also requires `DOTBOT_PUBLIC_QUICK_PLAY=true`; otherwise the legacy quick-play and room-code paths are unchanged.

## Party ownership and membership

- A party contains one to three pre-run players. The run-scoped recruited fourth squad member is never written to this roster.
- `parties.id` is a database UUID and never leaves the control-plane persistence layer. A random, non-enumerable matchmaking key is the only party identifier allowed across the signed control-plane, AWS, GameLift, and arena boundary.
- `parties.version` starts at one and increments for every join, leave, leader transfer, merge-driven membership change, or deletion-driven leader change. Disband is terminal and deletes the party. Invite creation, expiry, replay, and revocation do not alter membership and do not increment it.
- The leader is the current party owner-authority; there is no separate permanent creator privilege. Only a linked leader can create or revoke durable invite links. Any member may leave or cancel the intact party's queue claim. Only the leader may transfer leadership or disband.
- A leader who leaves transfers leadership to the oldest remaining linked member, otherwise the oldest remaining guest. The last member leaving disbands the party. Account deletion uses the same rule.
- A guest acceptance belongs to the accepting device session. It survives refresh and later games on that device. Linking that guest promotes the same membership to canonical linked-account ownership; a later linked device sees it. Losing an unlinked guest bearer does not create a recoverable cross-device social identity.
- A player can belong to at most one party. Accepting an invite while in another party is a conflict; the player must leave first. A full three-member party cannot create an invite and cannot accept another member.

## Invites and privacy

- Invite codes are random bearer credentials, stored only as SHA-256 hashes, accepted only in request bodies, and never used as URL path parameters or log fields.
- An invite belongs to the party, records the issuing leader and roster version for audit, expires after 24 hours, and can be revoked by the current linked leader. Leadership transfer does not silently make the former leader an owner; the new leader can revoke outstanding party-owned links.
- Reaccepting the same valid invite from the same canonical player/device is idempotent. A revoked, expired, disbanded, or unknown invite reveals no party details.
- Public party responses contain only formatted public player IDs, display names, leader markers, roster version, and caller capabilities. They never contain player UUIDs, retired aliases, device IDs or hashes, Firebase subjects/providers, the internal party UUID, the matchmaking key, queue claim IDs, or invite hashes.
- Party lookup is actor-scoped. There is no endpoint to enumerate parties, memberships, or players by matchmaking key.

## Queue claims and stale-roster behavior

- Queue request IDs are UUID idempotency keys. The first leader request creates a claim; later members of the same party retrieve that claim rather than creating independent allocations.
- Claim creation locks the party row, snapshots canonical player UUIDs and the membership version, and freezes membership for the claim lifetime. A concurrent join, leave, transfer, disband, merge, or account deletion either commits before the claim and changes its version, or loses the serialization race and returns `party_queued` until cancellation. No stale middle state is accepted.
- A control-plane response carries a canonical roster, request-bound issue/expiry timestamps, and an HMAC in the `party-roster` domain. The matchmaker verifies the signature, expiry, requesting member, roster uniqueness, cap, version, and configured build/region before allocation.
- Queue claims do not consume, mutate, or select loadouts. Loadout preparation remains a separate API. A later launch increment may attach an explicit loadout revision lock to queue entry without changing party membership semantics.
- Cancellation writes an AWS-side tombstone before cleanup, so it wins against an allocator that has not published. If GameLift creation races cancellation, the allocator compensates every returned reservation and never returns one member's connection.

## Whole-party allocation

1. Authenticate and claim the canonical versioned roster through the signed control-plane endpoint.
2. Select only the configured compatible build and the lowest trusted client-measured latency among allowed regions. There is no MMR or client-supplied party identity.
3. Read the exact active arena pointer and call its signed, replay-bounded, non-mutating full-roster preflight.
4. Atomically compare-and-swap the complete party into the arena directory's packing ledger. Concurrent allocators cannot both reserve an impossible composition.
5. Call GameLift `CreatePlayerSessions` once with the complete roster and one trusted metadata envelope per canonical player. Validate that the response contains exactly one reservation for every requested player.
6. Publish the idempotent allocation record only if it is still owned and not cancelled. Each authenticated party member receives only their own connection details.
7. On any incomplete response, publication race, cancellation, or retryable capacity/composition failure, release every returned player session and the directory reservation. Never return a partial allocation.
8. On a retryable preflight, capacity, or packing failure, conditionally retire only the exact stale/current pointer and retry the intact party against the replacement pointer or create a new arena. Late directory callbacks cannot reclaim the replacement.

Before `CreatePlayerSessions`, the allocator persists the exact GameSession, arena secret, canonical member UUIDs, and a bounded discovery window. If the SDK loses the mutation response, cleanup calls `DescribePlayerSessions` for those exact canonical members and accepts only reservation IDs whose player data carries this claim's valid `party-reservation` HMAC. A missing subset remains fail-closed until the reservation window has elapsed. New GameSession creation uses a claim-and-generation-derived idempotency token and stores that generation with its random arena ID and secret before the AWS mutation. An expired allocator or cancellation first fences the old owner, replays and terminates that exact generation, and only then permits a fresh allocator generation; a delayed old allocator can therefore terminate only its own GameSession.

## Whole-party arena admission

1. Each connecting member presents only their own GameLift player-session ID. The arena describes that reservation without accepting it, verifies its signed `party-reservation` metadata, and stages the peer outside Room state.
2. Staged members must produce the exact same claim, party key, roster version, build, region, arena, expiry, and ordered canonical roster. A missing, duplicate, stale, disconnected, or expired member releases the known reservations; no staged member receives a Room welcome.
3. Only after every signed roster member is staged does the adapter lock the complete session-ID set, describe every reservation again, and call GameLift acceptance for the batch. A validation failure accepts none. An uncertain or partial SDK acceptance triggers removal for every member and leaves the arena fail-closed if cleanup cannot be confirmed.
4. Only a successful exact batch acceptance reaches one synchronous Room commit. Room re-resolves account aliases and validates the complete capacity/composition before its first membership mutation, so no member can appear alone between awaits.
5. Reconnect and cleanup remain reservation-specific and idempotent. A client retry cannot turn an old roster or duplicate device into another seat.

The arena-specific preflight secret is random per GameSession, stored only in encrypted DynamoDB and trusted GameSession properties, and uses separate `party-preflight`, `party-reservation`, and `party-release` HMAC domains. It is never returned to a client. Existing matchmaker-auth and game-persistence domains remain separate.

## Failure and rollback rules

- Arena preflight never changes Room membership, countdown state, directory revision, or GameLift state.
- A batch with a missing, duplicate, expired, mismatched, or stale roster member is rejected before Room admission. Canonical UUIDs and retired UUID aliases are never interchangeable inside the roster; alias resolution happens in Cloud SQL before it is signed.
- Duplicate devices for one linked account resolve to the same canonical roster member and cannot consume two party or arena places.
- Uncertain or failed GameLift acceptance/removal retains the existing fail-closed binding and readiness degradation. Batch cleanup is idempotent and is retried against the exact reservation IDs.
- Feature-off behavior creates no durable party or queue-claim writes, accepts no versioned allocation metadata, and leaves legacy room-code/GameLift reconciliation intact.

## Content-neutral API surface

- `GET /api/social/party`
- `POST /api/social/party-invites`
- `DELETE /api/social/party-invites`
- `POST /api/social/party-invites/accept`
- `POST /api/social/party/leave`
- `POST /api/social/party/disband`
- `POST /api/social/party/leader`
- signed `POST /api/internal/matchmaker-auth` version `party-v1` for claim, retrieval, and cancellation
- signed arena `POST /api/internal/public-party-preflight`
- signed arena `POST /api/internal/public-party-release`
- public matchmaker `POST /quick-play` and `POST /quick-play/cancel`, both idempotent by queue request ID

The visual decision for where and how those actions appear remains a client/Claude Design seam.
