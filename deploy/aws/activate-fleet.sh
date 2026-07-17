#!/usr/bin/env bash
set -euo pipefail

region="us-east-1"
home_location="us-east-1"
game_location="ca-central-1"
instance_type="c7i.xlarge"
build_id="${BUILD_ID:-build-074d7f29-6003-457a-91b4-71f5042c9727}"
profile_args=()
if [[ -n "${AWS_PROFILE:-}" ]]; then profile_args=(--profile "$AWS_PROFILE"); fi

if [[ "${CONFIRM_PAID_ACTIVATION:-}" != "dotbot-one-instance" ]]; then
  echo "Set CONFIRM_PAID_ACTIVATION=dotbot-one-instance to cross the paid fleet boundary." >&2
  exit 64
fi

account_id=$(aws sts get-caller-identity "${profile_args[@]}" --query Account --output text)
if [[ "$account_id" != "380314682423" ]]; then
  echo "Refusing to activate in unexpected AWS account $account_id" >&2
  exit 1
fi

for location in "$home_location" "$game_location"; do
  quota=$(aws gamelift describe-ec2-instance-limits "${profile_args[@]}" \
    --region "$region" --ec2-instance-type "$instance_type" --location "$location" \
    --query 'EC2InstanceLimits[0].InstanceLimit' --output text)
  if ((quota < 1)); then
    echo "GameLift $instance_type quota is still $quota in $location; no fleet was created." >&2
    exit 1
  fi
done

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
  --ec2-inbound-permissions FromPort=7000,ToPort=7003,IpRange=0.0.0.0/0,Protocol=TCP \
  --new-game-session-protection-policy FullProtection \
  --runtime-configuration file://deploy/aws/fleet-runtime.json \
  --resource-creation-limit-policy NewGameSessionsPerCreator=2,PolicyPeriodInMinutes=1 \
  --fleet-type ON_DEMAND \
  --instance-role-arn arn:aws:iam::380314682423:role/DotBotGameLiftFleetRole \
  --instance-role-credentials-provider SHARED_CREDENTIAL_FILE \
  --certificate-configuration CertificateType=GENERATED \
  --locations Location="$game_location" \
  --log-paths /local/game/logs \
  --metric-groups DotBotProduction \
  --tags Key=Project,Value=DotBot Key=Environment,Value=production \
  --query 'FleetAttributes.FleetId' --output text)

echo "Created $fleet_id; AWS temporarily starts one instance in each location during activation."
aws gamelift wait fleet-active "${profile_args[@]}" --region "$region" --fleet-ids "$fleet_id"

# The home/control region never serves players. Scale it to zero immediately,
# then enforce the one-instance Canada ceiling.
aws gamelift update-fleet-capacity "${profile_args[@]}" --region "$region" \
  --fleet-id "$fleet_id" --location "$home_location" --desired-instances 0 --min-size 0 --max-size 0 >/dev/null
aws gamelift update-fleet-capacity "${profile_args[@]}" --region "$region" \
  --fleet-id "$fleet_id" --location "$game_location" --desired-instances 1 --min-size 0 --max-size 1 >/dev/null

aws cloudformation update-stack "${profile_args[@]}" --region "$region" \
  --stack-name dotbot-production-control-plane \
  --use-previous-template \
  --role-arn arn:aws:iam::380314682423:role/DotBotCloudFormationExecutionRole \
  --parameters \
    ParameterKey=FleetId,ParameterValue="$fleet_id" \
    ParameterKey=ControlPlaneUrl,UsePreviousValue=true \
    ParameterKey=RelaySecretArn,UsePreviousValue=true >/dev/null
aws cloudformation wait stack-update-complete "${profile_args[@]}" --region "$region" \
  --stack-name dotbot-production-control-plane

echo "Fleet $fleet_id is active: us-east-1 max=0, ca-central-1 max=1. Gameplay cutover is still OFF."
