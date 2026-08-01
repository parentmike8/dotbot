# Production realtime architecture

Status: production, 2026-07-31

## Product constraints

- One gameplay implementation across desktop web, mobile web, and a future
  Capacitor iOS/Android container.
- Current mobile browsers are first-class clients, not reduced spectators.
- A link remains enough to play; app-store installation is optional.
- Server authority, 60 Hz simulation, local input prediction, and remote
  interpolation remain the mechanical foundation.
- The Cloud Run service remains the account, base, inventory, and persistence
  authority. Dedicated game processes never receive database credentials.

## Runtime topology

```text
Browser / Capacitor
  |-- HTTPS: client, account, base, inventory
  |     -> Cloud Run (us-central1) -> Cloud SQL
  |
  |-- HTTPS: create/join room
  |     -> API Gateway + matchmaker Lambda (us-east-1)
  |          -> GameLift allocation (ca-central-1)
  |
  `-- direct WSS with GameLift-generated TLS
        -> allocated GameLift managed-EC2 process (ca-central-1)
             -> signed Lambda relay -> Cloud Run persistence allow-list
```

Cloud Run exposes the matchmaker URL through `/api/game-config`. Until that
value is configured, the same client falls back to the Cloud Run WebSocket
path, which is the emergency rollback path.

GameLift runs one On-Demand ARM64 `c6gn.large` at most. The instance hosts two
isolated room processes on TCP 7000 and 7001. Each process owns one allocated
game session and up to nine players. GameLift supplies the public DNS name and
TLS certificate, so browsers connect directly without a realtime proxy.

The process startup order is load-bearing:

1. initialize the GameLift SDK;
2. register `ProcessReady`, reporting bootstrap health while session
   activation remains gated;
3. obtain the generated certificate;
4. launch the Node server and pass its deep health check;
5. open the session-activation gate.

## Transport contract

The application protocol has two delivery classes:

- `reliable`: identity, lobby state, allocation, one-shot actions, combat
  confirmations, inventory, extraction, and match outcomes;
- `latest`: continuous movement input and superseding snapshots.

Production currently maps both classes to a direct secure WebSocket. The
server keeps compression, admission, reconnect, and backpressure rules in the
transport layer so game code depends on delivery semantics rather than a
browser API. WebTransport remains a possible future optimization, not part of
the deployed topology.

Every production connection must present the short-lived GameLift player
session returned by the matchmaker. The dedicated server verifies that the
reservation belongs to its exact game session before lobby admission. A mobile
network handoff keeps the reservation and player-controlled bot available for
20 seconds before AI takeover and removal.

## Persistence boundary

GameLift processes use short-lived fleet-role credentials to invoke only the
matchmaker Lambda. The Lambda signs a narrow, allow-listed persistence request
to Cloud Run. Cloud Run verifies timestamp, request ID, endpoint-scoped signature, replay
claim, operation, and payload before touching Cloud SQL. Database credentials
and the relay secret are not present on the fleet.

The allowed game-server operations cover identity resolution, tutorial and
insertion checks, match intelligence, match start, extraction/outcome writes,
and match finish. Base editing, fabrication, contracts, and arbitrary queries
remain unavailable from a dedicated match process.

## Combat timeline

An attack input carries the server tick of the remote world visible when the
action was generated. The server clamps and validates that tick, then resolves
the victim and contact point on the same historical timeline. It does not infer
combat time from a periodically reported full RTT.

The local predictor collides with remote bodies sampled from the rendered
timeline. It must never collide with a fresher, invisible snapshot. Predicted
impact presentation is keyed by attack ID and either confirmed or rejected by
an authoritative combat result.

## Regional and capacity policy

- GameLift build and fleet: Canada Central (`ca-central-1`).
- Cloud Run and Cloud SQL: Google `us-central1`.
- Allocation and persistence-relay Lambda: AWS `us-east-1`.
- GameLift instance type: On-Demand ARM64 `c6gn.large`.
- Hard fleet ceiling: one instance and two concurrent room processes.
- Idle policy: managed scale to and from zero after 30 inactive minutes.
- Session protection: full protection while a game session is active.
- Public game ports: TCP 7000-7001 only; adapter ports remain loopback-only.

Do not raise the process count or instance ceiling without measured 60 Hz tick,
memory, network, and reconnect headroom. Add a region when player latency data
shows a material population elsewhere; do not make the Canada fleet larger as
a substitute for regional placement.

## Mobile performance policy

- Landscape and portrait layouts respect safe areas and browser chrome.
- Touch input is sampled into the same 60 Hz input frames as keyboard/gamepad.
- Render resolution scales independently of world simulation.
- Quality reductions affect particles, shadows, and resolution before input,
  animation timing, collision, or snapshot cadence.
- Page background/resume performs explicit reconnect and state resync.
- Audio unlock, haptics, secure token storage, deep links, and push are native
  shell capabilities; they do not fork gameplay.
- The release gate includes current iPhone Safari, current Android Chrome, and
  at least one older supported device in each family.

## Cost and safety envelope

The live AWS price checked on 2026-07-31 for GameLift `c6gn.large` in Canada
Central was **$0.121 USD/hour**, or about **$88.33 for 730 continuously active
hours** before bandwidth and minor control-plane usage. Public quick play keeps
one instance warm because EC2 scale-from-zero latency is longer than the
seconds-long deployment contract. The explicit emergency-stop path can take
capacity to zero whenever public quick play is disabled.

The AWS account has a `$200 USD/month` budget with actual-spend alerts at 50%,
80%, and 100%, plus a forecasted 100% alert. Fleet activation rechecks the
regional instance limit, verifies zero existing usage, requires an explicit
paid confirmation, and refuses to create a second fleet. No Savings Plan or
commitment should be purchased until production utilization is measured.

## Release and rollback

The guarded order is:

1. apply additive Cloud SQL migrations;
2. deploy the current Cloud Run control service with GameLift routing off;
3. deploy the AWS control plane with the intended fleet ID;
4. publish and verify an immutable ARM64 GameLift build;
5. activate one fleet and validate allocation, generated TLS, player-session
   admission, persistence, and two independent clients;
6. set `DOTBOT_MATCHMAKER_URL` on Cloud Run;
7. verify `/api/game-config`, create/join, direct WSS, and game admission from
   the public service.

Rollback removes `DOTBOT_MATCHMAKER_URL` from Cloud Run. This returns room
creation to the existing Cloud Run WebSocket path without moving account or
persistence data. `deploy/aws/emergency-stop.sh` is the separate guarded path
for disabling GameLift capacity.
