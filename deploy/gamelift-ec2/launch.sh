#!/usr/bin/env bash
set -euo pipefail

game_root="/local/game"
game_port=""
adapter_port=""

while (($# > 0)); do
  case "$1" in
    -port|--port)
      game_port="${2:-}"
      shift 2
      ;;
    -adapter-port|--adapter-port)
      adapter_port="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown launch argument: $1" >&2
      exit 64
      ;;
  esac
done

if [[ ! "$game_port" =~ ^[0-9]+$ ]] || [[ ! "$adapter_port" =~ ^[0-9]+$ ]]; then
  echo "valid -port and -adapter-port values are required" >&2
  exit 64
fi

export GAME_PORT="$game_port"
export GAMELIFT_ADAPTER_PORT="$adapter_port"
export GAMELIFT_ADAPTER_URL="http://127.0.0.1:${adapter_port}"
export REQUIRE_GAMELIFT_TLS="true"
export AWS_REGION="us-east-1"
export DOTBOT_MATCHMAKER_FUNCTION="dotbot-production-matchmaker"

mkdir -p "$game_root/logs"
log_file="$game_root/logs/process-${game_port}.log"

"$game_root/gamelift-adapter" >>"$log_file" 2>&1 &
adapter_pid=$!
game_pid=""

shutdown() {
  if [[ -n "$game_pid" ]]; then
    kill -TERM "$game_pid" 2>/dev/null || true
  fi
  kill -TERM "$adapter_pid" 2>/dev/null || true
  if [[ -n "$game_pid" ]]; then
    wait "$game_pid" 2>/dev/null || true
  fi
  wait "$adapter_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

runtime_json=""
for _ in {1..120}; do
  if ! kill -0 "$adapter_pid" 2>/dev/null; then
    wait "$adapter_pid"
    exit $?
  fi
  if runtime_json=$(/usr/bin/curl --fail --silent --show-error \
      "${GAMELIFT_ADAPTER_URL}/v1/runtime" 2>/dev/null); then
    break
  fi
  sleep 0.25
done

if [[ -z "$runtime_json" ]]; then
  echo "GameLift TLS runtime did not become available" >&2
  exit 1
fi

certificate_path=$("$game_root/node/bin/node" -e \
  'const value=JSON.parse(process.argv[1]); if(!value.certificatePath) process.exit(1); process.stdout.write(value.certificatePath)' \
  "$runtime_json")

export NODE_ENV="gamelift"
export PORT="$game_port"
export GAMELIFT_TLS_CERTIFICATE="${certificate_path}/certificate.pem"
export GAMELIFT_TLS_CERTIFICATE_CHAIN="${certificate_path}/certificateChain.pem"
export GAMELIFT_TLS_PRIVATE_KEY="${certificate_path}/privateKey.pem"

"$game_root/node/bin/node" "$game_root/server/index.js" >>"$log_file" 2>&1 &
game_pid=$!

set +e
wait -n "$adapter_pid" "$game_pid"
exit_code=$?
set -e
shutdown
trap - EXIT
exit "$exit_code"
