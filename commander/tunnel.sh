#!/usr/bin/env bash
# Commander - expose the LOCAL daemon/service through a Cloudflare Tunnel so the Dub-hosted
# /commander page works from any device (phone, another PC) while this PC is up.
# Outbound-only: cloudflared dials Cloudflare, no inbound port is opened on this machine.
#
#   daemon  127.0.0.1:4319  <-  https://$COMMANDER_TUNNEL_DAEMON_HOST
#   service 127.0.0.1:8798  <-  https://$COMMANDER_TUNNEL_API_HOST
#
# Every route except /health requires COMMANDER_OPERATOR_TOKEN, so the token IS the lock:
# `up` refuses to run without a strong one. Paste the same token into the /commander
# "接続先を設定" form on each device (stored in that browser only).
#
# Usage:
#   bash commander/tunnel.sh setup   # once: create the tunnel + DNS via the CF API
#   bash commander/tunnel.sh up      # run cloudflared (foreground, Ctrl-C to stop)
#
# Requirements: `cloudflared` on PATH (brew install cloudflared) for `up`;
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (Tunnel + DNS edit) for `setup`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.commander.env.local"

ZONE="${COMMANDER_TUNNEL_ZONE:-developershub.jp}"
DAEMON_HOST="${COMMANDER_TUNNEL_DAEMON_HOST:-commander-daemon.$ZONE}"
API_HOST="${COMMANDER_TUNNEL_API_HOST:-commander-api.$ZONE}"
DAEMON_PORT="${COMMANDER_DAEMON_PORT:-4319}"
SERVICE_PORT="${COMMANDER_SERVICE_PORT:-8798}"
TUNNEL_NAME="${COMMANDER_TUNNEL_NAME:-dub-commander}"
CF="https://api.cloudflare.com/client/v4"

[[ -f "$ENV_FILE" ]] || { echo "[tunnel] $ENV_FILE not found - run commander/dev-up.sh once first." >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

cf() { # method path [json]
  curl -sS -X "$1" "$CF$2" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required}" \
    -H "content-type: application/json" ${3:+--data "$3"}
}
ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(d.get("errors"), file=sys.stderr) or 1))'; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

setup() {
  local acct="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}" id token zone_id host
  if [[ -n "${COMMANDER_TUNNEL_ID:-}" ]]; then
    id="$COMMANDER_TUNNEL_ID"
    echo "[tunnel] reusing tunnel $id"
  else
    local res; res="$(cf POST "/accounts/$acct/cfd_tunnel" "{\"name\":\"$TUNNEL_NAME\",\"config_src\":\"cloudflare\"}")"
    echo "$res" | ok
    id="$(echo "$res" | field "['result']['id']")"
    echo "COMMANDER_TUNNEL_ID=$id" >> "$ENV_FILE"
    echo "[tunnel] created tunnel $TUNNEL_NAME ($id)"
  fi
  token="$(cf GET "/accounts/$acct/cfd_tunnel/$id/token" | field "['result']")"
  grep -v '^COMMANDER_TUNNEL_TOKEN=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
  echo "COMMANDER_TUNNEL_TOKEN=$token" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE" && chmod 600 "$ENV_FILE"

  # Ingress lives on Cloudflare (remotely managed), so `up` needs only the tunnel token.
  # httpHostHeader: wrangler dev / the daemon expect a loopback Host.
  cf PUT "/accounts/$acct/cfd_tunnel/$id/configurations" "$(cat <<JSON
{"config":{"ingress":[
  {"hostname":"$DAEMON_HOST","service":"http://127.0.0.1:$DAEMON_PORT","originRequest":{"httpHostHeader":"127.0.0.1:$DAEMON_PORT"}},
  {"hostname":"$API_HOST","service":"http://127.0.0.1:$SERVICE_PORT","originRequest":{"httpHostHeader":"127.0.0.1:$SERVICE_PORT"}},
  {"service":"http_status:404"}]}}
JSON
)" | ok
  echo "[tunnel] ingress: $DAEMON_HOST -> :$DAEMON_PORT, $API_HOST -> :$SERVICE_PORT"

  zone_id="$(cf GET "/zones?name=$ZONE" | field "['result'][0]['id']")"
  for host in "$DAEMON_HOST" "$API_HOST"; do
    local existing; existing="$(cf GET "/zones/$zone_id/dns_records?name=$host" | field "['result']")"
    if [[ "$existing" != "[]" ]]; then echo "[tunnel] DNS $host already exists - left as is"; continue; fi
    cf POST "/zones/$zone_id/dns_records" \
      "{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"$id.cfargotunnel.com\",\"proxied\":true}" | ok
    echo "[tunnel] DNS $host -> $id.cfargotunnel.com"
  done
  echo "[tunnel] setup done. Next: bash commander/tunnel.sh up"
}

up() {
  command -v cloudflared >/dev/null || { echo "[tunnel] cloudflared not found (brew install cloudflared)" >&2; exit 1; }
  [[ -n "${COMMANDER_TUNNEL_TOKEN:-}" ]] || { echo "[tunnel] no tunnel yet - run: bash commander/tunnel.sh setup" >&2; exit 1; }
  # The operator token is the only lock on a public hostname that can drive local claude.
  if [[ "${#COMMANDER_OPERATOR_TOKEN}" -lt 32 ]]; then
    echo "[tunnel] COMMANDER_OPERATOR_TOKEN missing or too short (<32 chars) - refusing to expose." >&2
    exit 1
  fi
  echo "[tunnel] daemon  https://$DAEMON_HOST"
  echo "[tunnel] service https://$API_HOST"
  exec cloudflared tunnel --no-autoupdate run --token "$COMMANDER_TUNNEL_TOKEN"
}

case "${1:-}" in
  setup) setup ;;
  up) up ;;
  *) echo "usage: bash commander/tunnel.sh setup|up" >&2; exit 2 ;;
esac
