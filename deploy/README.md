# Production deployment

The public domain stays on the existing Google Cloud deployment. Cloud Run
serves the web/mobile client, account APIs, base/profile data, and the
authoritative persistence relay backed by Cloud SQL. Once the final cutover is
enabled, realtime rooms are allocated to a single-region Amazon GameLift
Managed EC2 fleet in Canada (`ca-central-1`) and the browser connects directly
to its generated TLS/WSS endpoint.

Until `DOTBOT_MATCHMAKER_URL` is set on Cloud Run, gameplay continues to use
the current Cloud Run websocket path. That makes deployment and gameplay
cutover separate, reversible operations.

## Deploy the Google control plane

```
./deploy/deploy.sh
```

Cloud Build builds the root Dockerfile from source and Cloud Run swaps
revisions with zero config drift. The single-instance realtime flags remain in
place as a rollback path until the GameLift cutover has been validated.

## Run a schema migration against production

Migrations are applied from your machine through the Cloud SQL Auth Proxy —
the database has no public IP exposure. The guarded script reads the existing
Secret Manager value without printing it, removes Cloud Run's Unix-socket
transport parameter, starts and stops the proxy, and runs every pending
migration:

```
# one-time: install the proxy
brew install cloud-sql-proxy

# --gcloud-auth reuses your gcloud CLI login (plain ADC goes stale separately)
CONFIRM_DOTBOT_PRODUCTION_MIGRATION=dot-bot-c39fc ./deploy/migrate-production.sh
```

## Operate

- Logs:    `gcloud run services logs read dotbot --region us-central1 --project dot-bot-c39fc --limit 100`
- Health:  `curl <service-url>/api/health` (rooms, tick p99, per-room bandwidth)
- Rollback: `gcloud run services update-traffic dotbot --to-revisions <rev>=100 --region us-central1`

## Production GameLift release order

1. Apply the additive Cloud SQL migration.
2. Deploy and verify Cloud Run with GameLift routing still disabled.
3. Deploy the AWS control plane with `FleetId=pending-quota-approval`.
4. Publish the Canada ARM64 GameLift build.
5. After AWS grants `c7g.large` capacity in `ca-central-1`, run
   `deploy/aws/activate-fleet.sh` with the new build ID and the explicit paid
   activation confirmation.
6. Validate two real devices against the production fleet.
7. Run `deploy/aws/cutover.sh` to enable GameLift allocation on the same public
   domain.

The fleet script enforces an On-Demand `c7g.large`, a hard maximum of one
instance, two room processes, and managed scale-to-zero after 30 idle minutes.
The first room after an idle scale-down automatically waits and retries while
AWS wakes the instance. Never raise the process count or instance ceiling
without measured 60 Hz tick, network, and memory headroom.

Cutover rollback does not require a redeploy:

```
gcloud run services update dotbot --project dot-bot-c39fc --region us-central1 --remove-env-vars DOTBOT_MATCHMAKER_URL
```
