#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$script_dir/../.." && pwd)
compose_file="$script_dir/compose.yml"
state_dir="$script_dir/.state"
cert_dir="$state_dir/certs"
public_dir="$state_dir/public"
profile_file="$state_dir/profile"
ip_file="$state_dir/lan-ip"
proxy_api="http://127.0.0.1:8474"
proxy_name="dotbot_game"
ca_common_name="DotBot Local Lab Root CA"

compose() {
  docker compose --project-name dotbot-local-parity --file "$compose_file" "$@"
}

fail() {
  echo "DotBot lab: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required."
}

valid_ipv4() {
  local address=$1
  local first second third fourth part
  IFS=. read -r first second third fourth <<<"$address"
  for part in "$first" "$second" "$third" "$fourth"; do
    [[ "$part" =~ ^[0-9]{1,3}$ ]] || return 1
    ((10#$part <= 255)) || return 1
  done
}

detect_lan_ip() {
  local candidate="${DOTBOT_LAB_IP:-}"
  local network_device=""
  if [[ -n "$candidate" ]]; then
    valid_ipv4 "$candidate" || fail "DOTBOT_LAB_IP must be a valid IPv4 address."
    echo "$candidate"
    return
  fi
  if command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    network_device=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
    if [[ -n "$network_device" ]]; then
      candidate=$(ipconfig getifaddr "$network_device" 2>/dev/null || true)
    fi
    if [[ -z "$candidate" ]]; then
      candidate=$(ipconfig getifaddr en0 2>/dev/null || true)
    fi
    if [[ -z "$candidate" ]]; then
      candidate=$(ipconfig getifaddr en1 2>/dev/null || true)
    fi
  fi
  if [[ -n "$candidate" ]] && valid_ipv4 "$candidate"; then
    echo "$candidate"
  else
    echo "127.0.0.1"
  fi
}

ensure_certificates() {
  local lan_ip=$1
  local cert_config="$state_dir/server-cert.cnf"
  local csr="$state_dir/server.csr"
  local saved_ip=""
  local local_hostname="dotbot-local"
  local certificate_data certificate_uuid profile_uuid serial

  mkdir -p "$cert_dir" "$public_dir"
  if [[ ! -f "$cert_dir/ca.key" || ! -f "$cert_dir/ca.crt" ]]; then
    echo "Creating the private DotBot local-lab certificate authority..."
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$cert_dir/ca.key" >/dev/null 2>&1
    openssl req -x509 -new -sha256 -days 3650 \
      -key "$cert_dir/ca.key" \
      -subj "/CN=$ca_common_name" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -out "$cert_dir/ca.crt"
  fi

  if [[ -f "$ip_file" ]]; then
    saved_ip=$(sed -n '1p' "$ip_file")
  fi
  if [[ -f "$cert_dir/server.crt" && -f "$cert_dir/server.key" \
    && -f "$public_dir/DotBot-Local-Lab-CA.crt" \
    && -f "$public_dir/DotBot-Local-Lab.mobileconfig" \
    && "$saved_ip" == "$lan_ip" ]]; then
    return
  fi

  if command -v scutil >/dev/null 2>&1; then
    local_hostname=$(scutil --get LocalHostName 2>/dev/null | tr -cd 'A-Za-z0-9-' || true)
    [[ -n "$local_hostname" ]] || local_hostname="dotbot-local"
  fi

  {
    printf '%s\n' '[req]'
    printf '%s\n' 'prompt = no'
    printf '%s\n' 'distinguished_name = subject'
    printf '%s\n' 'req_extensions = server_extensions'
    printf '%s\n' '[subject]'
    printf '%s\n' 'CN = DotBot Local Production Lab'
    printf '%s\n' '[server_extensions]'
    printf '%s\n' 'basicConstraints = critical,CA:FALSE'
    printf '%s\n' 'keyUsage = critical,digitalSignature,keyEncipherment'
    printf '%s\n' 'extendedKeyUsage = serverAuth'
    printf '%s\n' 'subjectAltName = @names'
    printf '%s\n' '[names]'
    printf '%s\n' 'DNS.1 = localhost'
    printf '%s\n' 'DNS.2 = host.docker.internal'
    printf 'DNS.3 = %s.local\n' "$local_hostname"
    printf '%s\n' 'IP.1 = 127.0.0.1'
    if [[ "$lan_ip" != "127.0.0.1" ]]; then
      printf 'IP.2 = %s\n' "$lan_ip"
    fi
  } >"$cert_config"

  echo "Creating a TLS certificate for localhost and $lan_ip..."
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$cert_dir/server.key" >/dev/null 2>&1
  openssl req -new -key "$cert_dir/server.key" -config "$cert_config" -out "$csr"
  serial=$(openssl rand -hex 16)
  openssl x509 -req -sha256 -days 825 \
    -in "$csr" \
    -CA "$cert_dir/ca.crt" \
    -CAkey "$cert_dir/ca.key" \
    -set_serial "0x$serial" \
    -extfile "$cert_config" \
    -extensions server_extensions \
    -out "$cert_dir/server.crt" >/dev/null
  printf '%s\n' "$lan_ip" >"$ip_file"

  cp "$cert_dir/ca.crt" "$public_dir/DotBot-Local-Lab-CA.crt"
  openssl x509 -in "$cert_dir/ca.crt" -outform der -out "$state_dir/ca.der"
  certificate_data=$(openssl base64 -A -in "$state_dir/ca.der")
  certificate_uuid=$(uuidgen)
  profile_uuid=$(uuidgen)
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '%s\n' '<key>PayloadContent</key><array><dict>'
    printf '%s\n' '<key>PayloadCertificateFileName</key><string>DotBot Local Lab CA</string>'
    printf '<key>PayloadContent</key><data>%s</data>\n' "$certificate_data"
    printf '%s\n' '<key>PayloadDescription</key><string>Trusts only the private DotBot local production lab.</string>'
    printf '%s\n' '<key>PayloadDisplayName</key><string>DotBot Local Lab CA</string>'
    printf '%s\n' '<key>PayloadIdentifier</key><string>com.dotbot.local-lab.ca</string>'
    printf '%s\n' '<key>PayloadType</key><string>com.apple.security.root</string>'
    printf '<key>PayloadUUID</key><string>%s</string>\n' "$certificate_uuid"
    printf '%s\n' '<key>PayloadVersion</key><integer>1</integer>'
    printf '%s\n' '</dict></array>'
    printf '%s\n' '<key>PayloadDescription</key><string>Enables HTTPS for DotBot on this local network.</string>'
    printf '%s\n' '<key>PayloadDisplayName</key><string>DotBot Local Production Lab</string>'
    printf '%s\n' '<key>PayloadIdentifier</key><string>com.dotbot.local-lab</string>'
    printf '%s\n' '<key>PayloadOrganization</key><string>DotBot</string>'
    printf '%s\n' '<key>PayloadRemovalDisallowed</key><false/>'
    printf '%s\n' '<key>PayloadType</key><string>Configuration</string>'
    printf '<key>PayloadUUID</key><string>%s</string>\n' "$profile_uuid"
    printf '%s\n' '<key>PayloadVersion</key><integer>1</integer>'
    printf '%s\n' '</dict></plist>'
  } >"$public_dir/DotBot-Local-Lab.mobileconfig"

  chmod 600 "$cert_dir/ca.key" "$cert_dir/server.key"
  chmod 644 "$cert_dir/ca.crt" "$cert_dir/server.crt" "$public_dir"/*
}

wait_for_proxy_api() {
  local attempt
  for attempt in $(seq 1 80); do
    if curl --fail --silent "$proxy_api/version" >/dev/null 2>&1; then
      return
    fi
    sleep 0.25
  done
  fail "the network-condition proxy did not become ready."
}

api_post() {
  local endpoint=$1
  local payload=${2:-}
  if [[ -n "$payload" ]]; then
    curl --fail --silent --show-error \
      -H 'Content-Type: application/json' \
      -X POST \
      --data "$payload" \
      "$proxy_api$endpoint" >/dev/null
  else
    curl --fail --silent --show-error -X POST "$proxy_api$endpoint" >/dev/null
  fi
}

api_delete() {
  local endpoint=$1
  curl --fail --silent --show-error -X DELETE "$proxy_api$endpoint" >/dev/null
}

restore_proxy() {
  api_post "/proxies/$proxy_name" '{"enabled":true}' || true
}

remove_temporary_spike() {
  api_delete "/proxies/$proxy_name/toxics/temporary_spike_upstream" || true
  api_delete "/proxies/$proxy_name/toxics/temporary_spike_downstream" || true
}

configure_proxy() {
  api_post "/populate" '[{"name":"dotbot_game","listen":"0.0.0.0:8443","upstream":"app:8080","enabled":true}]'
}

add_latency() {
  local stream=$1
  local latency_ms=$2
  local jitter_ms=$3
  api_post "/proxies/$proxy_name/toxics" "{\"name\":\"latency_$stream\",\"type\":\"latency\",\"stream\":\"$stream\",\"toxicity\":1.0,\"attributes\":{\"latency\":$latency_ms,\"jitter\":$jitter_ms}}"
}

add_bandwidth() {
  local stream=$1
  local rate_kbps=$2
  api_post "/proxies/$proxy_name/toxics" "{\"name\":\"bandwidth_$stream\",\"type\":\"bandwidth\",\"stream\":\"$stream\",\"toxicity\":1.0,\"attributes\":{\"rate\":$rate_kbps}}"
}

apply_profile() {
  local requested=${1:-wifi}
  local profile=$requested
  case "$profile" in
    home) profile=wifi ;;
    cellular) profile=mobile ;;
  esac

  api_post "/reset"
  case "$profile" in
    clean)
      ;;
    wifi)
      add_latency upstream 15 5
      add_latency downstream 15 5
      ;;
    mobile)
      add_latency upstream 40 15
      add_latency downstream 40 15
      ;;
    rough)
      add_latency upstream 75 35
      add_latency downstream 75 35
      add_bandwidth upstream 64
      add_bandwidth downstream 128
      ;;
    *)
      fail "unknown profile '$requested' (use clean, wifi, mobile, or rough)."
      ;;
  esac
  printf '%s\n' "$profile" >"$profile_file"
  echo "Network profile: $profile"
}

wait_for_game() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl --fail --silent --cacert "$cert_dir/ca.crt" \
      --connect-timeout 3 --max-time 8 \
      https://localhost:8443/api/health >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done
  fail "the production game image did not become healthy. Run 'pnpm lab logs'."
}

show_urls() {
  local lan_ip=$1
  echo
  echo "DotBot production lab is ready."
  echo "Desktop: https://localhost:8443"
  if [[ "$lan_ip" != "127.0.0.1" ]]; then
    echo "Phone:   https://$lan_ip:8443"
    echo "iPhone certificate: http://$lan_ip:8088/DotBot-Local-Lab.mobileconfig"
    echo "Android certificate: http://$lan_ip:8088/DotBot-Local-Lab-CA.crt"
  else
    echo "No LAN address was detected; set DOTBOT_LAB_IP to enable phone access."
  fi
  echo
  echo "Change conditions: pnpm lab profile mobile"
  echo "Test a handoff:   pnpm lab interrupt 5"
  echo "Measure delivery: pnpm lab probe"
}

start_lab() {
  local profile=${1:-wifi}
  local lan_ip
  require_command docker
  require_command curl
  require_command openssl
  require_command uuidgen
  docker info >/dev/null 2>&1 || fail "Docker Desktop is not running."
  lan_ip=$(detect_lan_ip)
  ensure_certificates "$lan_ip"

  echo "Starting the isolated local database..."
  compose up -d postgres
  echo "Building the exact production image and migration runner..."
  compose build app migrate
  echo "Applying the production schema to the isolated local database..."
  compose run --rm migrate
  echo "Starting HTTPS/WSS and the network-condition proxy..."
  compose up -d app toxiproxy certshare
  wait_for_proxy_api
  configure_proxy
  apply_profile "$profile"
  wait_for_game
  show_urls "$lan_ip"
}

trust_ca() {
  local lan_ip keychain expected_fingerprint existing_fingerprint
  [[ "$(uname -s)" == "Darwin" ]] || fail "automatic certificate trust is currently supported only on macOS."
  require_command security
  require_command openssl
  lan_ip=$(detect_lan_ip)
  ensure_certificates "$lan_ip"
  keychain=$(security default-keychain -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
  [[ -n "$keychain" ]] || fail "could not locate the user login keychain."
  expected_fingerprint=$(openssl x509 -in "$cert_dir/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)
  if security find-certificate -c "$ca_common_name" "$keychain" >/dev/null 2>&1; then
    existing_fingerprint=$(security find-certificate -c "$ca_common_name" -p "$keychain" 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)
    if [[ "$existing_fingerprint" == "$expected_fingerprint" ]]; then
      echo "The DotBot local certificate is already trusted in the user keychain."
      return
    fi
    security delete-certificate -c "$ca_common_name" "$keychain" >/dev/null
  fi
  security add-trusted-cert -r trustRoot -k "$keychain" "$cert_dir/ca.crt"
  echo "Trusted '$ca_common_name' in the user login keychain only."
}

untrust_ca() {
  local keychain
  [[ "$(uname -s)" == "Darwin" ]] || fail "automatic certificate removal is currently supported only on macOS."
  keychain=$(security default-keychain -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')
  if security delete-certificate -c "$ca_common_name" "$keychain" >/dev/null 2>&1; then
    echo "Removed '$ca_common_name' from the user login keychain."
  else
    echo "The DotBot local certificate was not present in the user keychain."
  fi
}

show_status() {
  local current_profile="unknown"
  [[ -f "$profile_file" ]] && current_profile=$(sed -n '1p' "$profile_file")
  compose ps
  echo "Network profile: $current_profile"
  if [[ -f "$cert_dir/ca.crt" ]]; then
    curl --fail --silent --show-error --cacert "$cert_dir/ca.crt" \
      --connect-timeout 3 --max-time 8 \
      https://localhost:8443/api/health
    echo
  fi
}

interrupt_network() {
  local duration=${1:-5}
  [[ "$duration" =~ ^[0-9]+$ ]] || fail "interrupt duration must be a whole number of seconds."
  ((duration >= 1 && duration <= 30)) || fail "interrupt duration must be between 1 and 30 seconds."
  wait_for_proxy_api
  echo "Disconnecting every lab client for $duration seconds..."
  api_post "/proxies/$proxy_name" '{"enabled":false}'
  trap restore_proxy EXIT
  trap 'exit 130' INT TERM
  sleep "$duration"
  restore_proxy
  trap - EXIT INT TERM
  echo "Network restored. The production reconnect path should recover automatically."
}

inject_spike() {
  local latency_ms=${1:-180}
  local duration=${2:-3}
  [[ "$latency_ms" =~ ^[0-9]+$ ]] || fail "spike latency must be a whole number of milliseconds."
  [[ "$duration" =~ ^[0-9]+$ ]] || fail "spike duration must be a whole number of seconds."
  ((latency_ms >= 25 && latency_ms <= 2000)) || fail "spike latency must be between 25 and 2000 ms per direction."
  ((duration >= 1 && duration <= 30)) || fail "spike duration must be between 1 and 30 seconds."
  wait_for_proxy_api
  api_post "/proxies/$proxy_name/toxics" "{\"name\":\"temporary_spike_upstream\",\"type\":\"latency\",\"stream\":\"upstream\",\"toxicity\":1.0,\"attributes\":{\"latency\":$latency_ms,\"jitter\":0}}"
  api_post "/proxies/$proxy_name/toxics" "{\"name\":\"temporary_spike_downstream\",\"type\":\"latency\",\"stream\":\"downstream\",\"toxicity\":1.0,\"attributes\":{\"latency\":$latency_ms,\"jitter\":0}}"
  trap remove_temporary_spike EXIT
  trap 'exit 130' INT TERM
  echo "Adding ${latency_ms}ms per direction for $duration seconds..."
  sleep "$duration"
  remove_temporary_spike
  trap - EXIT INT TERM
  echo "Latency spike removed."
}

run_probe() {
  [[ -f "$cert_dir/ca.crt" ]] || fail "start the lab first."
  wait_for_game
  compose run --rm \
    -e NODE_EXTRA_CA_CERTS=/certs/ca.crt \
    -e JITTER_URL=https://host.docker.internal:8443 \
    -e DURATION_MS="${DURATION_MS:-20000}" \
    migrate pnpm --filter @dotbot/server jitterprobe
}

open_lab() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "open https://localhost:8443 in a browser."
  open https://localhost:8443
}

usage() {
  cat <<'EOF'
DotBot local production lab

  pnpm lab start [clean|wifi|mobile|rough]  Build and start the lab
  pnpm lab trust                            Trust its private CA on this Mac
  pnpm lab open                             Open the desktop game
  pnpm lab profile <name>                   Change conditions live
  pnpm lab interrupt [seconds]              Simulate a network handoff
  pnpm lab spike [ms] [seconds]             Add a temporary latency spike
  pnpm lab probe                            Measure RTT and snapshot delivery
  pnpm lab status                           Show containers and server health
  pnpm lab logs                             Follow local server/proxy logs
  pnpm lab stop                             Stop the lab; preserve local data
  pnpm lab untrust                          Remove the private CA from this Mac
EOF
}

command_name=${1:-help}
shift || true
case "$command_name" in
  start) start_lab "${1:-wifi}" ;;
  trust) trust_ca ;;
  untrust) untrust_ca ;;
  open) open_lab ;;
  profile)
    [[ $# -ge 1 ]] || fail "choose clean, wifi, mobile, or rough."
    wait_for_proxy_api
    apply_profile "$1"
    ;;
  interrupt) interrupt_network "${1:-5}" ;;
  spike) inject_spike "${1:-180}" "${2:-3}" ;;
  probe) run_probe ;;
  status) show_status ;;
  logs) compose logs --follow app toxiproxy ;;
  stop) compose down ;;
  help|-h|--help) usage ;;
  *) fail "unknown command '$command_name'. Run 'pnpm lab help'." ;;
esac
