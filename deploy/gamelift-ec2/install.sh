#!/usr/bin/env bash
set -euo pipefail

game_root="/local/game"

chmod 0555 \
  "$game_root/gamelift-adapter" \
  "$game_root/launch.sh" \
  "$game_root/node/bin/node"

test -f "$game_root/server/index.js"
test -f "$game_root/node/bin/node"
test -f "$game_root/gamelift-adapter"
test -x "$game_root/gamelift-adapter"

"$game_root/node/bin/node" --version
