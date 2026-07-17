#!/usr/bin/env bash
set -euo pipefail

node /repo/apps/server/dist/index.js &
game_pid=$!

/usr/local/bin/gamelift-adapter &
adapter_pid=$!

shutdown() {
  kill -TERM "$adapter_pid" "$game_pid" 2>/dev/null || true
  wait "$adapter_pid" 2>/dev/null || true
  wait "$game_pid" 2>/dev/null || true
}

trap shutdown INT TERM EXIT

if wait -n "$game_pid" "$adapter_pid"; then
  exit_code=0
else
  exit_code=$?
fi
shutdown
trap - EXIT
exit "$exit_code"
