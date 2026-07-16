#!/usr/bin/env bash
# One-command production deploy: Cloud Build builds the Dockerfile, Cloud Run
# ships it. Run from the repo root: ./deploy/deploy.sh
#
# The flags are load-bearing for a realtime game server:
#   --min-instances=1 --max-instances=1  rooms live in process memory
#   --no-cpu-throttling                  the 60Hz sim must run between requests
#   --timeout=3600                       websockets live up to Cloud Run's max
#   --session-affinity                   reconnects land on the same instance
set -euo pipefail

PROJECT="dot-bot-c39fc"
REGION="us-central1"
SERVICE="dotbot"
SQL_INSTANCE="${PROJECT}:${REGION}:dotbot-sql"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --source . \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --cpu=1 \
  --memory=1Gi \
  --timeout=3600 \
  --session-affinity \
  --add-cloudsql-instances "$SQL_INSTANCE" \
  --set-secrets "DATABASE_URL=dotbot-database-url:latest" \
  --set-env-vars "NODE_ENV=production"

gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format="value(status.url)"
