#!/usr/bin/env bash
#
# deploy-demo — the ONLY sanctioned way to put the fe2 admin SPA on the shared `fe2-demo`
# slot. Replaces ad-hoc `wrangler deploy --config wrangler.demo.toml`, which — run by many
# agents at once — clobbered each other and left reviewers looking at a stale/other build
# with no record of who overwrote what.
#
# It bundles the three things that were missing:
#   1. SERIALIZATION  — a machine-wide lock so two concurrent demo deploys queue, never race.
#   2. MANIFEST       — writes deploy-state/demo.json (SHA, branch, actor, markers, time) so
#                       the current slot occupant is always explicit.
#   3. LIVENESS GATE  — after deploy, verify-live.sh asserts your feature markers are in the
#                       SERVED bundle. If they are not, the deploy is flagged NOT live and
#                       this script exits non-zero — so you never hand out a stale/empty URL.
#
# Usage:
#   scripts/deploy-demo.sh --markers "<m1>[,<m2>,...]" [--note "<text>"]
#
#   --markers  REQUIRED. Comma-separated feature-unique strings that MUST appear in the
#              served bundle (a data-testid you added, a unique label, a build stamp). This
#              is what makes "実装した" checkable. Refuses to run without it.
#   --note     optional free-text stored in the manifest.
#   --no-build skip the Vite build (use the existing apps/fe2-app-shell/dist).
#   --lock-timeout <s>  how long to wait for the slot lock (default 600).
#
# Requires: CLOUDFLARE_API_TOKEN in env (e.g. `export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)`).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MARKERS_CSV=""; NOTE=""; DO_BUILD=1; LOCK_TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in
    --markers)      MARKERS_CSV="${2:?}"; shift 2 ;;
    --note)         NOTE="${2:-}"; shift 2 ;;
    --no-build)     DO_BUILD=0; shift ;;
    --lock-timeout) LOCK_TIMEOUT="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,34p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$MARKERS_CSV" ]; then
  echo "::error::--markers is required. Pass the feature-unique string(s) that prove the build is live, e.g. --markers \"data-testid=gantt-marquee\". Without it the deploy cannot be verified and must not be handed to a reviewer." >&2
  exit 2
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "::error::CLOUDFLARE_API_TOKEN is not set. export CLOUDFLARE_API_TOKEN=\$(cat ~/Desktop/cf-token.txt)" >&2
  exit 1
fi

# markers CSV -> array (trim spaces around commas)
IFS=',' read -r -a MARKERS <<< "$MARKERS_CSV"
for i in "${!MARKERS[@]}"; do MARKERS[$i]="$(printf '%s' "${MARKERS[$i]}" | sed 's/^ *//;s/ *$//')"; done

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
ACTOR="${GITHUB_ACTOR:-$(git config user.name 2>/dev/null || echo "${USER:-unknown}")}"

# ---- 1. SERIALIZE: machine-wide atomic lock (mkdir is atomic on all POSIX fs) ------
LOCK="${TMPDIR:-/tmp}/dub-demo-deploy.lock"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  if [ "$waited" -ge "$LOCK_TIMEOUT" ]; then
    echo "::error::timed out waiting ${LOCK_TIMEOUT}s for the demo slot lock ($LOCK). Another demo deploy is in flight; retry or remove the lock if stale." >&2
    exit 1
  fi
  holder="$(cat "$LOCK/holder" 2>/dev/null || echo '?')"
  [ "$((waited % 15))" -eq 0 ] && echo "waiting for demo slot lock (held by: ${holder}) ... ${waited}s"
  sleep 3; waited=$((waited+3))
done
printf '%s @ %s (sha %s)\n' "$ACTOR" "$(date -u +%FT%TZ)" "$SHA" > "$LOCK/holder"
cleanup() { rm -rf "$LOCK"; }
trap cleanup EXIT

# Warn if we are about to overwrite a still-relevant review.
if [ -f deploy-state/demo.json ]; then
  prev_actor="$(grep -oE '"actor"[^,]*' deploy-state/demo.json | sed 's/.*: *//; s/[",]//g' || true)"
  prev_sha="$(grep -oE '"deployedSha"[^,]*' deploy-state/demo.json | sed 's/.*: *//; s/[",]//g' || true)"
  if [ -n "${prev_actor:-}" ] && [ "$prev_actor" != "null" ] && [ "$prev_sha" != "$SHA" ]; then
    echo "::warning::demo slot currently holds ${prev_sha} by ${prev_actor}. You are overwriting it — make sure their review is done."
  fi
fi

# ---- 2. BUILD (demo transport baked in via VITE_DEMO=1) ----------------------------
if [ "$DO_BUILD" = 1 ]; then
  echo "::group::build fe2 (VITE_DEMO=1)"
  VITE_DEMO=1 pnpm --filter @dub/fe2-app-shell build
  echo "::endgroup::"
fi

DIST="apps/fe2-app-shell/dist"
# Fail BEFORE deploying if the markers aren't even in the freshly built bundle — catches
# "I forgot to actually add the code / built the wrong thing" without touching the slot.
echo "::group::pre-deploy check (built dist)"
built_ok=1
for m in "${MARKERS[@]}"; do
  if grep -rqF -- "$m" "$DIST" 2>/dev/null; then echo "  ✓ in dist  $m"; else echo "  ✗ NOT in dist  $m"; built_ok=0; fi
done
echo "::endgroup::"
if [ "$built_ok" != 1 ]; then
  echo "::error::marker(s) not found in the built bundle ($DIST). The feature isn't in this build — fix the code/build before deploying. Slot untouched." >&2
  exit 3
fi

# ---- 3. DEPLOY to the fe2-demo slot ------------------------------------------------
echo "::group::wrangler deploy fe2-demo"
export CLOUDFLARE_API_TOKEN="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | tr -d '[:space:]')"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && export CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | tr -d '[:space:]')"
pnpm dlx wrangler@4.35.0 deploy --config apps/fe2-app-shell/wrangler.demo.toml
echo "::endgroup::"

# ---- 4. LIVENESS: assert the served slot now really contains the feature -----------
echo "::group::post-deploy liveness (served slot)"
live=true
if bash scripts/verify-live.sh demo "${MARKERS[@]}"; then live=true; else live=false; fi
echo "::endgroup::"

# ---- 5. MANIFEST: record the current slot occupant ---------------------------------
now="$(date -u +%FT%TZ)"
markers_json=""; first=1
for m in "${MARKERS[@]}"; do
  e="${m//\\/\\\\}"; e="${e//\"/\\\"}"
  if [ "$first" = 1 ]; then markers_json="\"$e\""; first=0; else markers_json="$markers_json, \"$e\""; fi
done
note_esc="${NOTE//\\/\\\\}"; note_esc="${note_esc//\"/\\\"}"
cat > deploy-state/demo.json <<JSON
{
  "env": "demo",
  "url": "https://fe2-demo.developershub-site.workers.dev",
  "deployedSha": "$SHA",
  "branch": "$BRANCH",
  "actor": "$ACTOR",
  "markers": [$markers_json],
  "live": $live,
  "verifiedAt": "$now",
  "updatedAt": "$now",
  "note": "$note_esc"
}
JSON
echo "manifest written: deploy-state/demo.json (live=$live)"

if [ "$live" != true ]; then
  echo "::error::demo deploy is NOT live for the given markers — do NOT ask anyone to 確認して. Investigate (wrong build? cache? clobbered by a concurrent deploy?)." >&2
  exit 3
fi

echo ""
echo "demo LIVE ✅  https://fe2-demo.developershub-site.workers.dev  (sha $SHA, by $ACTOR)"
echo "Commit deploy-state/demo.json so the slot occupant is recorded."
