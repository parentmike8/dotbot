#!/usr/bin/env bash
set -euo pipefail

project="dot-bot-c39fc"
instance="dot-bot-c39fc:us-central1:dotbot-sql"
secret="dotbot-database-url"
port="${DOTBOT_MIGRATION_PORT:-55433}"
confirmation="${CONFIRM_DOTBOT_PRODUCTION_MIGRATION:-}"

if [[ "$confirmation" != "$project" ]]; then
  echo "Set CONFIRM_DOTBOT_PRODUCTION_MIGRATION=$project to apply production schema migrations." >&2
  exit 1
fi

for command_name in cloud-sql-proxy gcloud nc node pnpm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
proxy_log_dir=$(mktemp -d)
proxy_log="$proxy_log_dir/cloud-sql-proxy.log"

cleanup() {
  if [[ -n "${proxy_pid:-}" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$proxy_log"
  rmdir "$proxy_log_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cloud-sql-proxy "$instance" --address 127.0.0.1 --port "$port" --gcloud-auth >"$proxy_log" 2>&1 &
proxy_pid=$!

proxy_ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
    proxy_ready=1
    break
  fi
  sleep 1
done

if [[ "$proxy_ready" -ne 1 ]]; then
  echo "Cloud SQL Auth Proxy did not become ready." >&2
  sed -n '1,120p' "$proxy_log" >&2
  exit 1
fi

production_database_url=$(gcloud secrets versions access latest --secret "$secret" --project "$project")
proxy_database_url=$(
  DOTBOT_DATABASE_URL="$production_database_url" DOTBOT_MIGRATION_PORT="$port" node -e '
    const url = new URL(process.env.DOTBOT_DATABASE_URL);
    url.hostname = "127.0.0.1";
    url.port = process.env.DOTBOT_MIGRATION_PORT;
    url.searchParams.delete("host");
    url.searchParams.delete("sslmode");
    process.stdout.write(url.toString());
  '
)

cd "$repo_root"
CI=1 NO_COLOR=1 DATABASE_URL="$proxy_database_url" pnpm db:migrate
