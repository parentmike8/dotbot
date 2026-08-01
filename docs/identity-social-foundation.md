# Identity and social foundation

Status: implementation contract, 2026-08-01

This document fixes ownership and merge behavior before account and social APIs
are expanded. It intentionally does not specify the visual treatment of account
creation, `SAVE YOUR PROGRESS`, friends, or parties.

## Authority and identifiers

- Cloud SQL/Postgres owns the player record, progress, device sessions,
  friendships, party invitations, and account-deletion transaction.
- Firebase Auth owns authentication and recovery. DotBot never receives or
  stores a password. The accepted provider policy is passwordless email link
  and phone/SMS code only.
- A Firebase identity token is accepted only after an injected verifier checks
  its signature, issuer, audience, expiry, and supported sign-in provider.
  Tests use an in-process verifier and never call Firebase.
- `players.id` is the internal persistence UUID. It may cross the signed
  dedicated-server persistence boundary, but it must not appear in public HTTP,
  WebSocket, friend, invite, log-summary, or client-storage contracts.
- `players.public_player_id` is an immutable uppercase eight-character value
  from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Public rendering inserts one hyphen
  (`XXXX-XXXX`); lookup removes the hyphen and is case-insensitive. Creation
  retries a unique-index collision rather than exposing or substituting the
  internal UUID.
- Retired public IDs are tombstoned in `player_aliases` with their own unique
  index. They remain valid only for in-flight reservation reconciliation and
  can never be allocated to a new account. A database delete trigger preserves
  the current ID even if a transitional older writer performs the deletion;
  deleting a canonical target nulls redirects but retains every tombstone.
- Display names are non-unique, changeable, whitespace-normalized, and limited
  to 24 characters.

## Device and provider model

- A guest is a normal `players` row with progress and at least one entry in
  `player_devices`, but no row in `external_identities`.
- Device tokens remain opaque 128-bit random bearer credentials. Only their
  SHA-256 hashes are stored. Existing `players.device_token_hash` values are
  copied into `player_devices`; the old column is retained for mixed-version
  guest-insert compatibility. The database default uses the same
  alphabet and a same-candidate advisory lock so an older service revision can
  omit the new column during rollout without failing or racing a collision.
- A linked account is a player with a Firebase `external_identities` row.
  `(issuer, subject)` is globally unique. `identity_providers` records the
  verified provider kinds observed for that Firebase identity without storing
  email addresses or phone numbers.
- A clean device exchanges a verified Firebase token for a new device token.
  Linking an existing guest keeps its current device token valid. Logging in on
  another device adds a device row; it does not rotate or invalidate other
  devices.
- Firebase reports both passwordless email-link and email/password sign-in with
  the `password` provider identifier, so the ID token cannot distinguish them.
  The server therefore requires `FIREBASE_AUTH_TENANT_ID`, verifies through the
  tenant-aware Admin SDK, and rejects a token whose tenant claim differs. Before
  accepting every `password` token it also reads the authoritative tenant
  config and requires password authentication disabled plus email-link sign-in
  enabled. It then records that provider as `email_link`; `phone` is the only
  other accepted provider. A missing tenant setting or configuration read fails
  closed. The stored issuer includes the tenant namespace because Firebase UIDs
  are tenant-local.

Rollout becomes forward-only after the first merge or cross-device session:
older service revisions do not read `player_devices` and cannot recover every
moved or additional token. Deploy the matchmaker's signed-endpoint client first
(its temporary 404 fallback still accepts the old control plane), then apply
migrations, deploy the identity-aware control plane, and finally roll the
identity-aware GameLift/hot-arena build. A rollback after identity writes must
roll forward or use a transitional reader; it must not silently strand devices.

## Atomic guest merge

`POST /api/auth/link` is an idempotent transaction keyed by the verified
Firebase `(issuer, subject)`, not by client timing.

1. Lock the current device's guest player and any player already owning the
   Firebase identity.
2. If the identity is unclaimed, attach it to the guest row. The guest UUID and
   every progress row remain unchanged.
3. If the identity already belongs to that row, update the provider evidence
   and return the same account without duplicating anything.
4. If the identity belongs to another linked player, that linked player is the
   canonical target and the current guest is the source. Merge all source data,
   move every source device session, record one merge receipt, then delete the
   source player in the same transaction. An internal alias redirects that
   retired UUID to the canonical target so an already-running arena can finish
   persistence safely and a reservation allocated just before the merge can
   still connect; the alias is never part of a public contract.

Merge rules are deliberately conservative:

- additive inventory quantities are summed;
- learned Blueprints and base upgrades are unioned;
- match participation and historical manifests move to the target unless the
  target already owns the same match row, in which case the target row wins and
  the conflict is recorded;
- tutorial progress keeps the furthest valid revision;
- equipped loadouts from both profiles are returned to target STASH and the
  merged loadout starts empty, preventing an accidental duplicate or loss;
- established linked-account display name, shell, base layout, presets,
  insertion preference, and active Contract state win a conflict; the source
  values are retained in the private merge receipt for support recovery;
- friend edges already owned by the source are re-keyed to the target,
  de-duplicated with accepted status winning over pending, and never create
  self-friendships; simultaneous reciprocal requests atomically become friends;
- a transaction failure leaves both profiles and the external identity exactly
  as they were before the attempt.
- if both profiles are participants in the same still-active match, linking is
  deferred with a conflict; collapsing two live runtimes onto one participant
  row is never attempted.

The merge never creates a second linked game profile, never wipes progression,
and is safe to replay after a client timeout.

## HTTP API contract

All player responses expose only `{ publicPlayerId, displayName }`; the legacy
`playerId` response field, where retained for protocol compatibility, contains
the formatted public ID.

- `POST /api/auth/register { name }` creates an immediately playable guest and
  returns a device token plus public identity. Production WebSocket and signed
  dedicated-server admission resolve existing device tokens only; they cannot
  create players around the registration limiter.
- `POST /api/auth/hello { token }` resumes a guest or linked device session.
- `POST /api/auth/link` requires `x-device-token` and a verified Firebase bearer
  token. It atomically attaches or merges and returns the canonical identity.
- `POST /api/auth/session` requires a verified Firebase bearer token and issues
  a fresh device token for the already-linked account.
- `GET /api/account` returns link state and public identity.
- `PATCH /api/account/profile { displayName }` changes only the display name.
- `DELETE /api/account` requires both a current device token and a freshly
  authenticated Firebase token (maximum authentication age: five minutes) for
  the same linked player. It deletes DotBot game
  data transactionally; it does not delete or disable the Firebase user.
- `GET /api/social/friends`, friend request/accept routes, friend lookup, and
  party-invite creation require a linked account.
- `POST /api/social/party-invites/accept { code }` accepts either a guest or
  linked device token. The bearer code stays in the request body rather than a
  logged URL path. A guest receives a one-session acceptance result but creates
  no durable friendship or social ownership. A linked acceptance is durable.

## Privacy and security boundaries

- Friend discovery returns only formatted public ID and display name. It never
  supports display-name enumeration and never returns UUID, device hashes,
  Firebase subjects, provider metadata, email, or phone.
- Friend and invite mutations derive the actor from the device token; request
  bodies cannot select an internal player.
- Only linked accounts own durable friend edges and party invitations.
- Party invite codes are high-entropy, stored only as hashes, kept out of URL
  and request-summary logs, expire, and reveal only the inviter's public
  identity when accepted.
- The in-process abuse limiter is defense in depth and scoped to one Cloud Run
  instance. Production must also enforce distributed/perimeter rate limits;
  the application limiter alone is not a global quota.
- Account deletion cannot be authorized by a device token alone once an
  account is linked. A Firebase identity mismatch is a conflict, not a request
  to merge or delete either player.
- Match summaries contain aggregate outcome counts, not participant IDs. On
  deletion, any legacy summary for a match containing that player is reduced
  transactionally to a non-identifying reason marker before participant rows
  cascade away.
- Identity, social, and account operations are control-plane-only. They are not
  added to the dedicated-server persistence allow-list.
- Matchmaker authentication uses a separate signed internal endpoint and keeps
  the established UUID only inside the control-plane/AWS reservation boundary.
  Matchmaker authentication and game persistence use distinct HMAC signature
  domains, so a signed request for one endpoint cannot consume a replay nonce
  or authorize the other. Public auth responses and game clients receive only
  the public player ID.
- When Postgres is unavailable, guest registration/hello can retain an
  ephemeral, token-derived UI identity, but base and game admission fail closed
  because progression authority cannot be verified. Linking, cross-device
  login, durable friends, invites, and deletion return an explicit
  storage-unavailable state. Stateless fallback identifiers are SHA-256-derived
  and never expose bearer-token characters.

## Client bootstrap seam

The client keeps the current guest-name and device-token bootstrap. Account
state is fetched separately so a failed Firebase or social request cannot gate
base movement or a run. After a completed run the client may expose an
accessible, dismissible `SAVE YOUR PROGRESS` action when `linked` is false;
visual design and Firebase SDK UI are separate work. Invite routes are parsed
before account state so a guest can choose a name, obtain a device token, and
accept a `#/party/:code` link without creating an account. The lobby calls the
profile PATCH when its editable display name changes; a failed rename does not
block deployment.

## Hot-arena integration boundary

GameLift and identity admission remain separate, ordered checks:

1. `GameLiftSessionGate` accepts the opaque player-session ID and returns the
   reservation's player ID.
2. The server pins that accepted session to the connection while
   `RoomManager` resolves the current database identity.
3. `RoomManager` treats the canonical UUID, a retired internal UUID, the
   canonical public ID, or a retired public ID as equivalent only for that
   reservation check.
4. `Room.join` receives the canonical persistence UUID and public runtime ID;
   it rejects a second device for an already admitted account.

`RoomManager` rechecks transport liveness after each awaited identity,
progress, or assigned-room lookup. A closed connection therefore cannot be
admitted by a late identity completion; this liveness guard does not allocate
or advance a directory revision.

Identity aliases never allocate, cache, compare, or advance an arena-directory
revision. Directory revision ownership stays at directory call entry, before
any asynchronous GameLift lookup. Out-of-order directory completion therefore
cannot be made current by an identity result, and a later identity merge cannot
change the revision attached to an existing directory operation.
