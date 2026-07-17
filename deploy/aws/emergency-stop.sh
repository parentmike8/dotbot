#!/usr/bin/env bash
set -euo pipefail

region="ca-central-1"
fleet_id="${FLEET_ID:-}"
profile_args=()
if [[ -n "${AWS_PROFILE:-}" ]]; then profile_args=(--profile "$AWS_PROFILE"); fi

if [[ ! "$fleet_id" =~ ^fleet-[0-9a-f-]+$ ]]; then
  echo "Set FLEET_ID to the DotBot production fleet." >&2
  exit 64
fi
if [[ "${CONFIRM_EMERGENCY_STOP:-}" != "dotbot-stop-capacity" ]]; then
  echo "Set CONFIRM_EMERGENCY_STOP=dotbot-stop-capacity to disable fleet capacity." >&2
  exit 64
fi

account_id=$(aws sts get-caller-identity "${profile_args[@]}" --query Account --output text)
if [[ "$account_id" != "380314682423" ]]; then
  echo "Refusing to stop capacity in unexpected AWS account $account_id" >&2
  exit 1
fi

aws gamelift update-fleet-capacity "${profile_args[@]}" --region "$region" \
  --fleet-id "$fleet_id" \
  --desired-instances 0 --min-size 0 --max-size 0 \
  --managed-capacity-configuration ZeroCapacityStrategy=MANUAL >/dev/null

echo "Fleet $fleet_id is capped at zero. Active protected sessions may finish before the final instance exits."
echo "Also remove DOTBOT_MATCHMAKER_URL from Cloud Run if gameplay cutover was enabled."
