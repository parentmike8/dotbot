# Local production-parity lab

This lab runs the compiled DotBot production image locally. On Apple Silicon,
that is also the same ARM64 architecture as the planned `c7g` GameLift fleet;
on an x86 machine the code and build path remain identical but the CPU
architecture does not. It uses production gameplay defaults, a private
PostgreSQL database, direct HTTPS/WSS termination in the Node game server, and
a transparent TCP proxy for repeatable network conditions. It does not read
cloud credentials, contact the production database, create AWS resources, or
change the live deployment.

It is deliberately not a separate playtest build. The root production
`Dockerfile` builds both the browser client and authoritative server. The lab
changes only the database address, locally signed TLS certificate, and route
through the network-condition proxy.

## Start

Docker Desktop must be running.

```bash
pnpm lab start wifi
pnpm lab trust
pnpm lab open
```

`trust` is a one-time macOS step. It installs only the private **DotBot Local
Lab Root CA** in the current user's login keychain. Remove it at any time with
`pnpm lab untrust`.

The local database persists across stops, but is isolated in the
`dotbot-local-parity` Docker project:

```bash
pnpm lab stop
```

## Network profiles

Latency is applied independently in both directions, so the approximate RTT
is twice the one-way value.

| Profile | Conditions | Purpose |
|---|---|---|
| `clean` | Transparent proxy only | Establish the local processing baseline |
| `wifi` | 15 ± 5 ms each way | Good nearby broadband/Wi-Fi |
| `mobile` | 40 ± 15 ms each way | Typical mobile internet |
| `rough` | 75 ± 35 ms each way; 64 KB/s up, 128 KB/s down | Adverse but playable mobile conditions |

Profiles can change during an active match:

```bash
pnpm lab profile mobile
pnpm lab profile rough
pnpm lab profile clean
```

Two additional faults exercise reconnection and correction behavior:

```bash
pnpm lab interrupt 5
pnpm lab spike 180 3
```

`interrupt` drops active TCP connections, waits, then restores the endpoint.
`spike` temporarily adds the requested latency in each direction without
changing the selected base profile.

## Measure rather than guess

Run the existing production WebSocket probe through the currently selected
profile:

```bash
pnpm lab probe
```

It reports snapshot inter-arrival p50/p90/p99/max, bursts, stalls, and RTT.
These fields are directly comparable with the same probe pointed at Cloud Run
or GameLift. During human testing, F3 adds client prediction error and
correction frequency.

## Real phones

The start command prints the detected LAN address. The phone and Mac must be
on the same local network.

For iPhone/iPad:

1. Open the printed `http://<LAN-IP>:8088/DotBot-Local-Lab.mobileconfig` link in
   Safari and install the downloaded profile in Settings.
2. In **Settings → General → About → Certificate Trust Settings**, enable full
   trust for **DotBot Local Lab Root CA**.
3. Open the printed `https://<LAN-IP>:8443` game link.

For Android, download the printed `.crt` link, install it as a CA certificate,
then open the HTTPS game link. Remove the certificate/profile after testing if
the device is not dedicated to development.

Only the public CA certificate is exposed on port 8088. Its private key stays
inside the ignored `.state/certs` directory and is excluded from Docker build
contexts.

## Honest boundary

The lab reproduces the production client, game simulation, 60 Hz authoritative
loop, snapshot protocol, TLS/WSS transport, persistence schema, reconnect
logic, and controlled network impairment. A local computer cannot reproduce
GameLift allocation, AWS host scheduling, the real regional internet route, or
a phone's radio transition. The private production fleet remains the final
release gate for those behaviors.
