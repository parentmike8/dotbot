# Production deployment (Google Cloud, project `dot-bot-c39fc`)

One Cloud Run service (`dotbot`, us-central1) serves everything — client, API,
and websockets — from a single URL, backed by Cloud SQL Postgres
(`dotbot-sql`). Firebase Hosting is deliberately NOT in the path: it cannot
proxy websockets. (This kit replaces the earlier Fly.io notes from M1/M3,
which were never provisioned.)

## Deploy a new build

```
./deploy/deploy.sh
```

Cloud Build builds the root Dockerfile from source and Cloud Run swaps
revisions with zero config drift. The critical service flags (single
instance, CPU always allocated, 1h websocket timeout, session affinity) live
in the script.

## Run a schema migration against production

Migrations are applied from your machine through the Cloud SQL Auth Proxy —
the database has no public IP exposure.

```
# one-time: install the proxy
brew install cloud-sql-proxy

cloud-sql-proxy dot-bot-c39fc:us-central1:dotbot-sql --port 55433 &
DATABASE_URL="postgres://dotbot:<password>@localhost:55433/dotbot" pnpm db:migrate
kill %1
```

The password lives in Secret Manager (`dotbot-database-url` holds the full
production URL; the proxy variant just swaps host/port):

```
gcloud secrets versions access latest --secret dotbot-database-url --project dot-bot-c39fc
```

## Operate

- Logs:    `gcloud run services logs read dotbot --region us-central1 --project dot-bot-c39fc --limit 100`
- Health:  `curl <service-url>/api/health` (rooms, tick p99, per-room bandwidth)
- Rollback: `gcloud run services update-traffic dotbot --to-revisions <rev>=100 --region us-central1`

## Known limits (fine for playtests)

- Cloud Run caps a websocket at 60 minutes; a drop mid-run hits the 15s
  reconnect grace (AI handoff). Rooms are in-process: never raise
  max-instances above 1 without a rooms-routing layer.
- db-f1-micro is the smallest tier; watch `/api/health` if concurrent rooms
  grow past a handful.
