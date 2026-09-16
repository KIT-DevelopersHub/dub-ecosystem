#!/usr/bin/env bash
# Commander - one-shot LOCAL launcher. Brings up the whole Commander stack with a
# single shared operator token so you can try it end-to-end in a browser:
#
#   daemon (exec bridge, spawns your local `claude`)  ->  127.0.0.1:DAEMON_PORT
#   commander-service (phase-gate API, local D1)      ->  127.0.0.1:SERVICE_PORT
#   web (Vite dev, run console + phase board)         ->  127.0.0.1:WEB_PORT
#
# The token is generated once into commander/.commander.env.local (gitignored, never
# committed - secrets stay local). Ports are overridable via env; defaults avoid the
# LP dev server already on 4321.
#
# Usage:
#   bash commander/dev-up.sh            # start everything, print URLs, stay foreground (Ctrl-C to stop)
#   bash commander/dev-up.sh --check    # start, health-check + one smoke run (fake claude), tear down
#
# Requirements: Node >= 22, and a `claude` CLI on PATH (only for real runs; --check uses a fixture).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.commander.env.local"
STATE_DIR="$SCRIPT_DIR/.dev"          # gitignored: local D1 + logs
D1_DIR="$STATE_DIR/d1"
LOG_DIR="$STATE_DIR/logs"

DAEMON_PORT="${COMMANDER_DAEMON_PORT:-4319}"
SERVICE_PORT="${COMMANDER_SERVICE_PORT:-8798}"
WEB_PORT="${COMMANDER_WEB_PORT:-5609}"

MODE="${1:-up}"

mkdir -p "$D1_DIR" "$LOG_DIR"

# --- shared operator token (generate once, local only) ---------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "COMMANDER_OPERATOR_TOKEN=$(openssl rand -hex 32)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[dev-up] generated a new operator token -> $ENV_FILE"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
TOKEN="$COMMANDER_OPERATOR_TOKEN"

# --- resolve the wrangler bin from the pnpm store --------------------------------
WRANGLER="$(ls -d "$REPO_ROOT"/node_modules/.pnpm/wrangler@*/node_modules/wrangler/bin/wrangler.js 2>/dev/null | head -1 || true)"
if [[ -z "$WRANGLER" ]]; then
  echo "[dev-up] wrangler not found in the pnpm store - run 'pnpm install' at the repo root first." >&2
  exit 1
fi

MIGRATION="$REPO_ROOT/infra/d1/migrations/commander/0001_commander_init.sql"

PIDS=()
# Recursively kill a process and ALL its descendants (children first). Needed because
# our children spawn grandchildren that outlive a plain kill: wrangler -> workerd,
# pnpm -> vite. Leaving those orphaned would hold the ports and block the next run.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  echo ""
  echo "[dev-up] stopping..."
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    [[ -n "${pid:-}" ]] && kill_tree "$pid"
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_http() { # url, name, tries
  local url="$1" name="$2" tries="${3:-40}"
  local i
  for ((i=1; i<=tries; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then echo "[dev-up] ${name} up (${url})"; return 0; fi
    sleep 1
  done
  echo "[dev-up] ${name} did NOT come up at ${url}" >&2
  return 1
}

echo "[dev-up] building phase FSM + shared packages (idempotent)..."
pnpm --dir "$REPO_ROOT" --filter @dub/commander-phases --filter @dub/db --filter @dub/types build >/dev/null 2>&1 || true

# --- 1) commander-service local D1: apply the commander migration ---------------
echo "[dev-up] applying commander migration to local D1..."
( cd "$REPO_ROOT/services/commander-service" && \
  CI=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN="" \
  node "$WRANGLER" d1 execute dub-core --local --persist-to "$D1_DIR" --file "$MIGRATION" >/dev/null )

# --- 2) commander-service (phase-gate API) --------------------------------------
echo "[dev-up] starting commander-service on port ${SERVICE_PORT} ..."
( cd "$REPO_ROOT/services/commander-service" && \
  CI=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN="" \
  node "$WRANGLER" dev --local --persist-to "$D1_DIR" --ip 127.0.0.1 --port "$SERVICE_PORT" \
    --var "COMMANDER_OPERATOR_TOKEN:$TOKEN" ) >"$LOG_DIR/service.log" 2>&1 &
PIDS+=("$!")

# --- 3) daemon (exec bridge) ----------------------------------------------------
# --check uses a fixture instead of the real `claude` so verification never invokes
# your live Claude Code.
DAEMON_CLAUDE_ENV=()
if [[ "$MODE" == "--check" ]]; then
  DAEMON_CLAUDE_ENV=(COMMANDER_CLAUDE_BIN="$REPO_ROOT/commander/daemon/test/fixtures/fake-claude")
fi
echo "[dev-up] starting daemon on port ${DAEMON_PORT} ..."
( cd "$REPO_ROOT" && \
  env COMMANDER_PORT="$DAEMON_PORT" \
      COMMANDER_OPERATOR_TOKEN="$TOKEN" \
      COMMANDER_CWD="$REPO_ROOT" \
      COMMANDER_SERVICE_URL="http://127.0.0.1:$SERVICE_PORT" \
      COMMANDER_SERVICE_TOKEN="$TOKEN" \
      ${DAEMON_CLAUDE_ENV[@]+"${DAEMON_CLAUDE_ENV[@]}"} \
      node --experimental-strip-types commander/daemon/src/index.ts ) >"$LOG_DIR/daemon.log" 2>&1 &
PIDS+=("$!")

# --- 4) web (Vite dev) ----------------------------------------------------------
echo "[dev-up] starting web on port ${WEB_PORT} ..."
# `exec vite ...` (not `dev -- ...`): pnpm forwards args straight to the vite binary,
# so --port/--strictPort are honored (a `dev --` run leaks a literal `--` to vite).
( cd "$REPO_ROOT" && \
  env VITE_COMMANDER_DAEMON="http://127.0.0.1:$DAEMON_PORT" \
      VITE_COMMANDER_API="http://127.0.0.1:$SERVICE_PORT" \
      VITE_COMMANDER_TOKEN="$TOKEN" \
      pnpm --filter @dub/commander-web exec vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort ) >"$LOG_DIR/web.log" 2>&1 &
PIDS+=("$!")

# --- health checks --------------------------------------------------------------
wait_http "http://127.0.0.1:$SERVICE_PORT/health" "commander-service"
wait_http "http://127.0.0.1:$DAEMON_PORT/health" "daemon"
wait_http "http://127.0.0.1:$WEB_PORT/" "web"

echo ""
echo "--------------------------------------------------------------"
echo " Commander is up. Open:  http://127.0.0.1:$WEB_PORT/"
echo "   daemon   : http://127.0.0.1:$DAEMON_PORT   (exec bridge, spawns your local claude)"
echo "   service  : http://127.0.0.1:$SERVICE_PORT  (phase-gate API, local D1)"
echo "   token    : $ENV_FILE (auto-passed to the web via VITE_COMMANDER_TOKEN)"
echo "   logs     : $LOG_DIR/{daemon,service,web}.log"
echo "--------------------------------------------------------------"

if [[ "$MODE" == "--check" ]]; then
  echo "[check] smoke: POST a run (fake claude) and confirm it succeeds + persists..."
  RUN=$(curl -s -XPOST "http://127.0.0.1:$DAEMON_PORT/runs" \
        -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
        -d '{"prompt":"Reply with PONG"}' | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
  echo "[check] runId=$RUN"
  ok=""
  st=""
  for i in $(seq 1 20); do
    st=$(curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$DAEMON_PORT/runs/$RUN" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1)
    if [[ "$st" == "succeeded" ]]; then ok="1"; break; fi
    if [[ "$st" == "failed" ]]; then break; fi
    sleep 1
  done
  if [[ -n "$ok" ]]; then echo "[check] daemon run: succeeded"; else echo "[check] daemon run did NOT succeed (status=$st)"; exit 1; fi
  pst=$(curl -s -H "x-commander-token: $TOKEN" "http://127.0.0.1:$SERVICE_PORT/runs/$RUN" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1)
  echo "[check] persisted run status in commander-service: ${pst:-<none>}"
  echo "[check] all good - tearing down."
  exit 0
fi

echo "[dev-up] Ctrl-C to stop. Logs are in $LOG_DIR."
wait
