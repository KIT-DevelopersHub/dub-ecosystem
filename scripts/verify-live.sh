#!/usr/bin/env bash
#
# verify-live — prove a feature is ACTUALLY live in a target environment before a
# human/agent is asked to "確認して" (verify it).
#
# WHY (the recurring failure this exists to kill):
#   demo and staging are each a SINGLE shared slot (one `fe2-demo` Worker; one shared
#   `-staging` set). Many agents deploy concurrently by hand, so:
#     * a later `wrangler deploy` CLOBBERS an earlier one while its author is still
#       reviewing it  -> the reviewer sees an OLD/other state.
#     * "実装した" but the bundle never actually reached the slot (build skipped, wrong
#       config, deploy raced) -> the feature is simply ABSENT from what is served.
#   Nothing checked the SERVED bundle for the feature before handing it over, so these
#   surfaced only when the user opened the URL and found it missing/stale.
#
# WHAT this does: fetch what the environment ACTUALLY serves right now (the fe2 SPA
# index.html + the JS/CSS asset bundles it references, and/or an API endpoint) and assert
# that every feature MARKER (a data-testid, a unique string, a build stamp, an API field)
# is present. If any marker is missing, exit non-zero — the feature is NOT live; do not
# ask anyone to confirm it.
#
# Usage:
#   scripts/verify-live.sh <env> <marker> [<marker> ...]
#   scripts/verify-live.sh <env> --api <path> --expect-status <code> [<marker> ...]
#   scripts/verify-live.sh --url <full-url> <marker> ...      # arbitrary target
#   scripts/verify-live.sh --file <path> <marker> ...         # offline: grep a local file
#                                                             #  (e.g. a freshly built dist)
#   scripts/verify-live.sh --self-test                        # no network; fixture check
#
#   <env> = demo | staging | prod
#   Every <marker> must be present (logical AND). Markers are fixed strings (grep -F).
#
# Options:
#   --json           also print a machine-readable result line (for manifests / CI)
#   --api <path>     additionally GET <origin><path> and require --expect-status
#   --expect-status  expected HTTP status for --api (default 200)
#   --timeout <s>    per-request curl timeout (default 20)
#
# Exit codes: 0 = all markers present (LIVE) · 3 = a marker missing (NOT live) ·
#             4 = environment unreachable · 2 = usage error.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBDOMAIN_DEFAULT="developershub-site"

# Resolve the workers.dev subdomain from the committed staging resource file when present
# (single source of truth); fall back to the known account subdomain otherwise.
resolve_subdomain() {
  local envfile="${ROOT}/infra/deploy/staging-resources.env" sub=""
  if [ -f "$envfile" ]; then
    sub="$(awk -F= '/^STAGING_WORKERS_SUBDOMAIN=/{print $2; exit}' "$envfile" | tr -d '[:space:]')"
  fi
  printf '%s' "${sub:-$SUBDOMAIN_DEFAULT}"
}

fe2_origin_for() {  # env -> the fe2 SPA origin actually served to users
  local env="$1" sub; sub="$(resolve_subdomain)"
  case "$env" in
    demo)    printf 'https://fe2-demo.%s.workers.dev' "$sub" ;;
    staging) printf 'https://dub-fe2-app-shell-staging.%s.workers.dev' "$sub" ;;
    prod)    printf 'https://dub-fe2-app-shell.%s.workers.dev' "$sub" ;;
    *) echo "::error::unknown env '$env' (want demo|staging|prod)" >&2; exit 2 ;;
  esac
}

gateway_origin_for() {  # env -> the api-gateway origin (for --api checks)
  local env="$1" sub; sub="$(resolve_subdomain)"
  case "$env" in
    demo)    printf '' ;;  # demo is backend-free (mock transport) — no gateway
    staging) printf 'https://dub-api-gateway-staging.%s.workers.dev' "$sub" ;;
    prod)    printf 'https://dub-api-gateway.%s.workers.dev' "$sub" ;;
  esac
}

# ---- args -------------------------------------------------------------------------
JSON=0; API_PATH=""; EXPECT_STATUS=200; TIMEOUT=20
MODE="env"; TARGET=""; ENVNAME=""
declare -a MARKERS=()

if [ "${1:-}" = "--self-test" ]; then MODE="selftest"; shift || true; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --json)          JSON=1; shift ;;
    --api)           API_PATH="${2:?--api needs a path}"; shift 2 ;;
    --expect-status) EXPECT_STATUS="${2:?}"; shift 2 ;;
    --timeout)       TIMEOUT="${2:?}"; shift 2 ;;
    --url)           MODE="url";  TARGET="${2:?--url needs a URL}"; shift 2 ;;
    --file)          MODE="file"; TARGET="${2:?--file needs a path}"; shift 2 ;;
    --self-test)     MODE="selftest"; shift ;;
    -h|--help)       sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --*)             echo "::error::unknown option '$1'" >&2; exit 2 ;;
    *)
      if [ "$MODE" = "env" ] && [ -z "$ENVNAME" ]; then ENVNAME="$1"
      else MARKERS+=("$1"); fi
      shift ;;
  esac
done

# ---- self-test (no network): validates the AND-of-markers grep logic --------------
if [ "$MODE" = "selftest" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  printf 'hello data-testid="gantt-marquee" v=abc123 world\n' > "$tmp/fixture.js"
  fail=0
  if bash "${BASH_SOURCE[0]}" --file "$tmp/fixture.js" 'gantt-marquee' 'abc123' >/dev/null 2>&1
    then echo "  ok  present-markers -> PASS"; else echo "  FAIL present-markers should PASS"; fail=1; fi
  if bash "${BASH_SOURCE[0]}" --file "$tmp/fixture.js" 'gantt-marquee' 'NOT_THERE' >/dev/null 2>&1
    then echo "  FAIL missing-marker should FAIL"; fail=1; else echo "  ok  missing-marker -> FAIL"; fi
  if bash "${BASH_SOURCE[0]}" --file "$tmp/no-such-file" 'x' >/dev/null 2>&1
    then echo "  FAIL unreachable should FAIL"; fail=1; else echo "  ok  unreachable-file -> FAIL"; fi
  [ "$fail" = 0 ] && { echo "self-test: PASS"; exit 0; } || { echo "self-test: FAIL"; exit 1; }
fi

if [ "${#MARKERS[@]}" -eq 0 ]; then
  echo "::error::no markers given — refusing to verify nothing. Pass a feature-unique string (data-testid, build stamp, API field)." >&2
  exit 2
fi

# ---- fetch the served payload into $BLOB ------------------------------------------
BLOB="$(mktemp)"; trap 'rm -f "$BLOB"' EXIT
DESC=""

fetch() {  # url -> append body to $BLOB; returns curl exit status
  curl -fsS --max-time "$TIMEOUT" --retry 3 --retry-delay 2 --retry-all-errors "$1" >> "$BLOB"
}

case "$MODE" in
  file)
    DESC="file:$TARGET"
    [ -f "$TARGET" ] || { echo "::error::file not found: $TARGET" >&2; exit 4; }
    cat "$TARGET" >> "$BLOB"
    ;;
  url)
    DESC="$TARGET"
    fetch "$TARGET" || { echo "::error::unreachable: $TARGET" >&2; exit 4; }
    ;;
  env)
    ORIGIN="$(fe2_origin_for "$ENVNAME")"
    DESC="$ENVNAME ($ORIGIN)"
    # 1) the SPA shell
    if ! fetch "${ORIGIN}/"; then echo "::error::$ENVNAME unreachable at ${ORIGIN}/" >&2; exit 4; fi
    # 2) every JS/CSS asset the shell references (the feature code lives here, not in HTML)
    assets="$(grep -oE '/?assets/[A-Za-z0-9_.-]+\.(js|css)' "$BLOB" | sort -u || true)"
    for a in $assets; do
      fetch "${ORIGIN}/${a#/}" || echo "::warning::could not fetch asset ${a}" >&2
    done
    # 3) optional API liveness (e.g. an endpoint that only exists once a service shipped)
    if [ -n "$API_PATH" ]; then
      GW="$(gateway_origin_for "$ENVNAME")"
      if [ -z "$GW" ]; then
        echo "::warning::--api ignored for env '$ENVNAME' (no gateway; demo is backend-free)" >&2
      else
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "${GW}${API_PATH}" || echo 000)"
        if [ "$code" != "$EXPECT_STATUS" ]; then
          echo "::error::API ${GW}${API_PATH} returned HTTP ${code}, expected ${EXPECT_STATUS}" >&2
          exit 3
        fi
        echo "  api ok  ${API_PATH} -> HTTP ${code}"
      fi
    fi
    ;;
esac

# Emit a JSON array of the markers (pure bash — no jq dependency).
markers_json() {
  local out="" m first=1
  for m in "${MARKERS[@]}"; do
    m="${m//\\/\\\\}"; m="${m//\"/\\\"}"   # escape backslash then quote
    if [ "$first" = 1 ]; then out="\"$m\""; first=0; else out="$out,\"$m\""; fi
  done
  printf '[%s]' "$out"
}

# ---- assert every marker is present (logical AND) ---------------------------------
missing=0
for m in "${MARKERS[@]}"; do
  if grep -qF -- "$m" "$BLOB"; then
    echo "  ✓ present  ${m}"
  else
    echo "  ✗ MISSING  ${m}"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "::error::NOT LIVE — ${DESC}: one or more markers missing. Do NOT ask anyone to confirm this." >&2
  [ "$JSON" = 1 ] && printf '{"live":false,"target":"%s","markers":%s}\n' "$DESC" "$(markers_json)"
  exit 3
fi

echo "LIVE — ${DESC}: all ${#MARKERS[@]} marker(s) present."
[ "$JSON" = 1 ] && printf '{"live":true,"target":"%s","markers":%s}\n' "$DESC" "$(markers_json)"
exit 0
