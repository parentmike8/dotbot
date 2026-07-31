# DotBot managed-container compatibility package

This directory packages the authoritative Node server and an Amazon GameLift
Servers SDK 5.5 adapter into one Linux/AMD64 container. It remains useful for
local lifecycle testing, but it is **not** the web production fleet package.

GameLift Managed Container fleets do not expose the generated-certificate
configuration required for direct secure WebSockets from an HTTPS browser.
DotBot therefore publishes the production runtime from `deploy/gamelift-ec2`,
using a GameLift Managed EC2 fleet with `CertificateType=GENERATED`. This keeps
TLS direct to the game process and avoids a latency-producing proxy.

## Production state (2026-07-31)

- AWS account: `380314682423` (`dotbot`)
- GameLift control/home region: `us-east-1`
- Production compute location: `ca-central-1`
- GitHub deploy role: `DotBotGitHubDeploy`, restricted to
  `parentmike8/dotbot` on `main`
- GameLift fleet role: `DotBotGameLiftFleetRole`
- CloudWatch log group: `/aws/gamelift/dotbot-production` in `us-east-1`,
  14-day retention
- Billing budget: `$200 USD/month`, with 50%, 80%, forecasted 100%, and actual
  100% email notifications
- Active fleet: `fleet-a7db4a18-3c9d-48f0-a706-9c368f92af29`
- Immutable production build: `build-1aa2e904-677e-4334-bd4d-038b625b9625`
- Paid GameLift capacity: zero to one On-Demand `c6gn.large`, managed down to
  zero after 30 inactive minutes
- Production fleet shape: one On-Demand ARM64 `c6gn.large` at most, running
  two room processes in `ca-central-1`
- The production validation admitted two independent clients into the same
  allocated room over the fleet's generated TLS endpoint. `activate-fleet.sh`
  rechecks regional routing, quota, current usage, and build readiness, and
  refuses activation if another fleet exists.

No workflow publishes this compatibility image and no container fleet exists.

Do not use the older `c7i.xlarge` or `c7g.large` quota requests to decide
whether this fleet can launch. GameLift limits are per instance type and
location. Verify the current `c6gn.large` GameLift price and the `$200` budget
alarms during every activation preflight; never raise the budget or the
one-instance ceiling without a separate measured capacity decision.

## Local verification

```bash
go test ./...
go vet ./...
docker build --platform linux/amd64 \
  -f deploy/gamelift/Dockerfile \
  -t dotbot-gamelift:local .
```

The adapter waits for `GET /api/health` before registering the process with
GameLift. Its loopback-only API exposes the assigned game session and accepts or
removes GameLift player-session IDs without exposing the SDK socket publicly.

## Production path

Use `deploy/gamelift-ec2/README.md` and the `Publish GameLift EC2 build`
workflow. Do not create or publish a managed-container fleet for the browser
client.
