# DotBot GameLift managed EC2 runtime

This is the production realtime-hosting package for the web and mobile game.
GameLift Managed EC2 is used instead of Managed Containers because the EC2
fleet supports GameLift-generated TLS certificates. That lets the HTTPS web
client connect directly with secure WebSockets, without a proxy in the hot
path.

The package contains a pinned ARM64 Linux Node runtime, the bundled
authoritative server, and the ARM64 Go GameLift SDK adapter. Two runtime
processes are configured on a `c7g.large`, each with its own public TLS port
and loopback adapter port. Each process admits exactly one allocated GameLift
game session, so the initial one-instance ceiling supports two simultaneous
rooms (up to 18 players) until production measurements justify more.

## Runtime ports

| Process | Player TLS port | Adapter loopback port |
|---|---:|---:|
| 1 | 7000 | 17000 |
| 2 | 7001 | 17001 |

The fleet inbound rule exposes TCP 7000-7001 only. Adapter ports bind to
`127.0.0.1` and are never exposed.

## Lifecycle

1. `launch.sh` starts the SDK adapter.
2. The adapter initializes GameLift and obtains the generated certificate.
3. The Node server starts with that certificate and serves HTTPS/WSS.
4. The adapter reports `ProcessReady` only after the Node health check passes.
5. The adapter describes every player reservation, verifies that it belongs
   to this exact game session, then accepts it before lobby admission.
6. A mobile network handoff keeps the reservation and player-controlled bot
   available for 20 seconds before AI takeover/removal.
7. On a GameLift termination request, new sockets are rejected while the
   adapter waits for the room and persistence writes to settle (bounded by a
   90-second shutdown deadline), then calls `ProcessEnding`.
8. When the assigned room expires, the process calls `ProcessEnding` and exits
   cleanly.

The fleet must be created with `CertificateType=GENERATED`, On-Demand
capacity, active-session protection, a hard maximum of one instance, and
managed scale-to-zero. The GameLift fleet/build live in `ca-central-1`; the
small allocation/persistence Lambda remains in `us-east-1` and is reached with
short-lived fleet-role credentials from `/local/credentials/credentials`.
