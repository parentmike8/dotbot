# DotBot managed-container compatibility package

This directory packages the authoritative Node server and an Amazon GameLift
Servers SDK 5.5 adapter into one Linux/AMD64 container. It remains useful for
local lifecycle testing, but it is **not** the web production fleet package.

GameLift Managed Container fleets do not expose the generated-certificate
configuration required for direct secure WebSockets from an HTTPS browser.
DotBot therefore publishes the production runtime from `deploy/gamelift-ec2`,
using a GameLift Managed EC2 fleet with `CertificateType=GENERATED`. This keeps
TLS direct to the game process and avoids a latency-producing proxy.

## Current safety state

- AWS account: `380314682423` (`dotbot`)
- GameLift control/home region: `us-east-1`
- Intended production compute location: `ca-central-1`
- ECR: `380314682423.dkr.ecr.us-east-1.amazonaws.com/dotbot-game-server`
- GitHub deploy role: `DotBotGitHubDeploy`, restricted to
  `parentmike8/dotbot` on `main`
- GameLift fleet role: `DotBotGameLiftFleetRole`
- CloudWatch log group: `/aws/gamelift/dotbot-production` in `us-east-1`,
  14-day retention
- Billing budget: `$200 USD/month`, with 50%, 80%, forecasted 100%, and actual
  100% email notifications
- Paid GameLift instances: **none**
- `c7i.xlarge` GameLift quota for the Canada Central fleet location: `0` until
  AWS approves an increase

The empty ECR repository and container-group IAM permissions are retained only
until the EC2 path is fully live; no workflow publishes this compatibility
image and no container fleet exists.

At the current AWS public rate, one Linux `c7i.xlarge` in Canada Central is
`$0.242/hour`, or about `$176.66` for a 730-hour month. The one-instance maximum
is therefore essential: it leaves roughly `$23.34/month` for logs, image
storage, and control-plane traffic under the `$200` budget.

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
