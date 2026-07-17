#!/usr/bin/env bash
set -euo pipefail

region="ca-central-1"
control_plane_region="us-east-1"
instance_type="c7g.large"
build_id="${BUILD_ID:-}"
profile_args=()
if [[ -n "${AWS_PROFILE:-}" ]]; then profile_args=(--profile "$AWS_PROFILE"); fi

if [[ ! "$build_id" =~ ^build-[0-9a-f-]+$ ]]; then
  echo "Set BUILD_ID to the READY Canada ARM64 GameLift build to activate." >&2
  exit 64
fi

if [[ "${CONFIRM_PAID_ACTIVATION:-}" != "dotbot-one-instance" ]]; then
  echo "Set CONFIRM_PAID_ACTIVATION=dotbot-one-instance to cross the paid fleet boundary." >&2
  exit 64
fi

account_id=$(aws sts get-caller-identity "${profile_args[@]}" --query Account --output text)
if [[ "$account_id" != "380314682423" ]]; then
  echo "Refusing to activate in unexpected AWS account $account_id" >&2
  exit 1
fi

quota=$(aws gamelift describe-ec2-instance-limits "${profile_args[@]}" \
  --region "$region" --ec2-instance-type "$instance_type" \
  --query 'EC2InstanceLimits[0].InstanceLimit' --output text)
if ((quota < 1)); then
  echo "GameLift $instance_type quota is still $quota in $region; no fleet was created." >&2
  exit 1
fi

build_status=$(aws gamelift describe-build "${profile_args[@]}" --region "$region" \
  --build-id "$build_id" --query 'Build.Status' --output text)
if [[ "$build_status" != "READY" ]]; then
  echo "GameLift build $build_id is $build_status, not READY." >&2
  exit 1
fi

existing_fleet=$(aws gamelift list-fleets "${profile_args[@]}" --region "$region" \
  --query 'FleetIds[0]' --output text)
if [[ "$existing_fleet" != "None" ]]; then
  echo "A GameLift fleet already exists ($existing_fleet); refusing to create a second paid fleet." >&2
  exit 1
fi

fleet_id=$(aws gamelift create-fleet "${profile_args[@]}" \
  --region "$region" \
  --name dotbot-production \
  --description "DotBot production authoritative realtime fleet" \
  --build-id "$build_id" \
  --ec2-instance-type "$instance_type" \
  --ec2-inbound-permissions FromPort=7000,ToPort=7001,IpRange=0.0.0.0/0,Protocol=TCP \
  --new-game-session-protection-policy FullProtection \
  --runtime-configuration file://deploy/aws/fleet-runtime.json \
  --resource-creation-limit-policy NewGameSessionsPerCreator=2,PolicyPeriodInMinutes=1 \
  --fleet-type ON_DEMAND \
  --instance-role-arn arn:aws:iam::380314682423:role/DotBotGameLiftFleetRole \
  --instance-role-credentials-provider SHARED_CREDENTIAL_FILE \
  --certificate-configuration CertificateType=GENERATED \
  --log-paths /local/game/logs \
  --metric-groups DotBotProduction \
  --tags Key=Project,Value=DotBot Key=Environment,Value=production \
  --query 'FleetAttributes.FleetId' --output text)

echo "Created $fleet_id; AWS temporarily starts one instance while activating the fleet."
aws gamelift wait fleet-active "${profile_args[@]}" --region "$region" --fleet-ids "$fleet_id"

# Enforce a hard one-instance ceiling. Managed capacity can scale an idle fleet
# to zero and wake one instance when a new game session is requested.
aws gamelift update-fleet-capacity "${profile_args[@]}" --region "$region" \
  --fleet-id "$fleet_id" --desired-instances 1 --max-size 1 \
  --managed-capacity-configuration ScaleInAfterInactivityMinutes=30,ZeroCapacityStrategy=SCALE_TO_AND_FROM_ZERO >/dev/null

aws cloudformation update-stack "${profile_args[@]}" --region "$control_plane_region" \
  --stack-name dotbot-production-control-plane \
  --use-previous-template \
  --role-arn arn:aws:iam::380314682423:role/DotBotCloudFormationExecutionRole \
  --parameters \
    ParameterKey=FleetId,ParameterValue="$fleet_id" \
    ParameterKey=ControlPlaneUrl,UsePreviousValue=true \
    ParameterKey=RelaySecretArn,UsePreviousValue=true >/dev/null
aws cloudformation wait stack-update-complete "${profile_args[@]}" --region "$control_plane_region" \
  --stack-name dotbot-production-control-plane

echo "Fleet $fleet_id is active in ca-central-1 on c7g.large: max=1 with idle scale-to-zero. Gameplay cutover is still OFF."
