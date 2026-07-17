# DotBot GameLift managed EC2 runtime

This is the production realtime-hosting package for the web and mobile game.
GameLift Managed EC2 is used instead of Managed Containers because the EC2
fleet supports GameLift-generated TLS certificates. That lets the HTTPS web
client connect directly with secure WebSockets, without a proxy in the hot
path.

The package contains a pinned Linux Node runtime, the bundled authoritative
server, and the Go GameLift SDK adapter. Four runtime processes are configured
on a `c7i.xlarge`, each with its own public TLS port and loopback adapter port.
Each process admits exactly one allocated GameLift game session.

## Runtime ports

| Process | Player TLS port | Adapter loopback port |
|---|---:|---:|
| 1 | 7000 | 17000 |
| 2 | 7001 | 17001 |
| 3 | 7002 | 17002 |
| 4 | 7003 | 17003 |

The fleet inbound rule exposes TCP 7000-7003 only. Adapter ports bind to
`127.0.0.1` and are never exposed.

## Lifecycle

1. `launch.sh` starts the SDK adapter.
2. The adapter initializes GameLift and obtains the generated certificate.
3. The Node server starts with that certificate and serves HTTPS/WSS.
4. The adapter reports `ProcessReady` only after the Node health check passes.
5. Every player session is accepted by the GameLift Server SDK before lobby
   admission. Disconnects remove the player session.
6. When the one assigned room expires, the process calls `ProcessEnding` and
   exits cleanly.

The fleet must be created with `CertificateType=GENERATED`, On-Demand
capacity, active-session protection, and a hard maximum of one instance.
