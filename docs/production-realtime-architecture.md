# Production realtime architecture

Status: accepted direction, 2026-07-16

## Product constraints

- One gameplay implementation across desktop web, mobile web, and a future
  Capacitor iOS/Android container.
- Current mobile browsers are first-class clients, not reduced spectators.
- A link must remain enough to play; app-store installation is optional.
- Server authority, 60 Hz simulation, local input prediction, and remote
  interpolation remain the mechanical foundation.
- Staging and production use the same runtime topology and protocol. Staging
  may run fewer replicas, but it is not a separate prototype architecture.

## Runtime topology

```text
Browser / Capacitor
  |-- HTTPS: account, base, inventory, matchmaking
  |     -> Cloud Run control service -> Cloud SQL
  |
  |-- primary realtime: WebTransport (QUIC, direct regional path)
  |     -> allocated Agones GameServer -> authoritative 60 Hz simulation
  |
  `-- compatibility realtime: WebSocket
        -> stable regional gateway -> allocated Agones GameServer
```

The existing React, PixiJS, TypeScript, Rapier, and protocol packages stay.
React remains outside the frame loop. Pixi remains the renderer. The server
simulation remains the only authority for damage, collision, and persistence.

## Transport contract

The application protocol has two delivery classes:

- `reliable`: identity, lobby state, allocation, one-shot actions, combat
  confirmations, inventory, extraction, and match outcomes.
- `latest`: continuous movement input and superseding snapshots.

WebTransport maps `latest` to QUIC datagrams and `reliable` to ordered streams.
The compatibility WebSocket maps both classes to its single ordered stream.
Game code depends on the delivery contract, not on either browser API.

Each allocated game-server pod terminates WebTransport beside the Node game
process. It exposes an Agones-assigned UDP host port. The allocation response
contains the server address, port, session token, and the hash of a short-lived
certificate generated for that process. This permits a secure direct browser
connection without putting a permanent relay in the fast path. Certificate
rotation and allocation-token expiry are automated.

WebSocket remains mandatory because WebTransport is new on current browsers
and operating-system WebViews can lag browser support. Compatibility traffic
may use the stable gateway; it must be measured separately so it never hides a
regression in the primary path.

## Combat timeline

An attack input carries the server tick of the remote world visible when the
action was generated. The server clamps and validates that tick, then resolves
the victim and contact point on the same historical timeline. It does not infer
combat time from a periodically reported full RTT.

The local predictor collides with remote bodies sampled from the rendered
timeline. It must never collide with a fresher, invisible snapshot. Predicted
impact presentation will be keyed by attack id and either confirmed or rejected
by an authoritative combat result; time-based FX deduplication is temporary.

## Regional layout

Launch region: `northamerica-northeast2` (Toronto).

- Regional GKE Standard cluster across three zones.
- Three fixed Agones system nodes, one per zone.
- Three minimum dedicated game nodes, one per zone; autoscale to twelve.
- Agones system workloads are tainted away from game nodes.
- Regular GKE release channel, auto-repair, auto-upgrade, Workload Identity,
  managed Prometheus, workload logging, and deletion protection.
- Direct game ports: UDP 7000-8000. TCP in the same range is reserved for
  operational fallback and migration, not assumed by the primary path.

When player latency data shows a material population outside northeastern
North America, add a region rather than making Toronto larger. Matchmaking
selects the lowest-latency healthy region and never moves a live match.

## Mobile performance policy

- Landscape and portrait layouts must respect safe areas and browser chrome.
- Touch input is sampled into the same 60 Hz input frames as keyboard/gamepad.
- Render resolution scales independently of world simulation.
- Quality reductions affect particles, shadows, and resolution before input,
  animation timing, collision, or snapshot cadence.
- Page background/resume performs explicit reconnect and state resync.
- Audio unlock, haptics, secure token storage, deep links, and push are native
  shell capabilities; they do not fork gameplay.
- The release gate includes current iPhone Safari, current Android Chrome, and
  at least one older supported device in each family. Capacitor WebViews have a
  separate transport-capability gate because browser support does not prove
  WebView support.

## Cost envelope (USD list price, Toronto)

The initial always-on high-availability floor is approximately **$575-$650 per
month**, before material player traffic. The estimate uses 730 hours/month:

| Component | Monthly estimate |
| --- | ---: |
| Regional GKE cluster management | $73 |
| 3 x `c4-standard-2` game nodes | $238 |
| 3 x `e2-standard-2` Agones system nodes | $162 |
| 6 x 30 GiB balanced persistent disks | $20 |
| External IPv4 addresses and network rules | $20-$40 |
| Existing Cloud Run control plane and Cloud SQL | $40-$55 |
| Initial logs, metrics, and modest egress allowance | $25-$60 |

Toronto list rates used on 2026-07-16 were $0.03815312/vCPU-hour plus
$0.004336132/GiB-hour for C4, $0.02401338/vCPU-hour plus
$0.00321816/GiB-hour for E2, $0.11/GiB-month for balanced disk, and
$0.12/GiB internet egress to the Americas. Actual billing varies with traffic,
logging volume, sustained-use/committed-use discounts, and taxes.

A higher-headroom floor with six game nodes is approximately **$815-$900 per
month**. Autoscaling above the three-node floor adds about **$79/month per
`c4-standard-2` node**, plus disk, IP, logging, and egress. No committed-use
discount should be purchased until production utilization is measured.

## Provisioning gate

Terraform under `deploy/gke/terraform` is the source of truth. Before the first
`terraform apply`:

1. confirm the monthly floor;
2. create the remote Terraform state bucket with versioning and retention;
3. enable the GKE API;
4. review the plan for six minimum nodes in Toronto and no resources elsewhere;
5. capture the plan artifact and obtain explicit approval;
6. apply, install Agones, run failure/latency gates, then shift realtime traffic.

The existing Cloud Run service remains live until the dedicated path passes the
same production protocol, persistence, reconnect, and mobile gates. It is a
rollback path during migration, not the final realtime host.
