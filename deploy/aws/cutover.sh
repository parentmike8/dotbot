#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONFIRM_GAMEPLAY_CUTOVER:-}" != "dotbot-gamelift-live" ]]; then
  echo "Set CONFIRM_GAMEPLAY_CUTOVER=dotbot-gamelift-live after the two-device production validation." >&2
  exit 64
fi

profile_args=()
if [[ -n "${AWS_PROFILE:-}" ]]; then profile_args=(--profile "$AWS_PROFILE"); fi

matchmaker_url=$(aws cloudformation describe-stacks "${profile_args[@]}" \
  --region us-east-1 --stack-name dotbot-production-control-plane \
  --query 'Stacks[0].Outputs[?OutputKey==`MatchmakerUrl`].OutputValue' --output text)

health=$(curl --fail --silent --show-error "${matchmaker_url}health")
if [[ "$health" != *'"fleetConfigured":true'* ]]; then
  echo "Matchmaker is not connected to an active fleet: $health" >&2
  exit 1
fi

gcloud run services update dotbot \
  --project dot-bot-c39fc \
  --region us-central1 \
  --update-env-vars "DOTBOT_MATCHMAKER_URL=$matchmaker_url" >/dev/null

echo "GameLift allocation is live. Roll back with:"
echo "gcloud run services update dotbot --project dot-bot-c39fc --region us-central1 --remove-env-vars DOTBOT_MATCHMAKER_URL"
