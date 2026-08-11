#!/usr/bin/env bash
#
# Ordered, dependency-safe production deploy of the free-tier Worker set.
#
# Single source of truth for deploy ORDER + post-deploy health gating, shared by:
#   - CI:     .github/workflows/deploy.yml  (runs on every merge to main)
#   - manual: bash infra/deploy/deploy-prod.sh
#
# Why an ordered script (not "deploy everything at once"): api-gateway holds 14
# Service Bindings (SVC_AUTH, SVC_IDENTITY, ...) and mo3-mobile-bff binds 5 more.
# A bind target Worker must already exist or the binding fails to resolve. auth
# also binds SVC_IDENTITY, so identity must land first. Order therefore is:
#   identity-roster -> auth-service -> peripheral services -> api-gateway
#   -> fe2-app-shell -> mo3-mobile-bff
#
# Requires in env:
#   CLOUDFLARE_API_TOKEN     (Workers Scripts:Edit, D1:Edit, Workers KV:Edit — see docs/DEPLOY.md)
#   CLOUDFLARE_ACCOUNT_ID    (optional; only if the token spans multiple accounts)
#
# Optional env:
#   SKIP_HEALTHCHECK=1                 skip the post-deploy smoke checks
#   GATEWAY_HEALTH_URL=<origin>        public gateway origin (default: workers.dev)
#   MOBILE_BFF_HEALTH_URL=<origin>     public mobile-bff origin (checked only if set)
#
# This script does NOT:
#   - apply D1 migrations  (see docs/DEPLOY.md §Migrations — applied out-of-band)
#   - touch Worker secrets (wrangler deploy preserves existing `wrangler secret` values)
#
set -euo pipefail

# pnpm dlx (NOT npx): this repo is a pnpm workspace, and `npx` run inside a pnpm
# workspace refuses to fetch a package that isn't a local dependency — it falls
# through to PATH and dies with `sh: wrangler: not found` (exit 127). `pnpm dlx`
# downloads + runs the pinned wrangler regardless of workspace context.
WRANGLER="pnpm dlx wrangler@4.35.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Strip stray whitespace/newlines from the CF credentials before wrangler sees them.
# WHY (real prod-deploy outage, not a wrangler-version bug): wrangler embeds
# CLOUDFLARE_ACCOUNT_ID verbatim into the API URL path. A single trailing space in the
# secret turns  GET /accounts/<id>/workers/services/<name>  into ".../<id> /workers/..."
# which the Cloudflare API router rejects with:
#   Could not route to /accounts/<id> /workers/... object identifier is invalid? [code: 7003]
#   No route for that URI [code: 7000]
# (Confirmed by repro: a clean-but-WRONG id fails as auth [10000]; a trailing NEWLINE is
# auto-trimmed by wrangler; only a trailing SPACE yields 7003 — exactly the CI failure.)
# Account ids and API tokens are single whitespace-free tokens, so removing ALL whitespace
# is safe and also absorbs leading/CR/newline damage from copy-paste into GitHub secrets.
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  export CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "${CLOUDFLARE_ACCOUNT_ID}" | tr -d '[:space:]')"
fi
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  export CLOUDFLARE_API_TOKEN="$(printf '%s' "${CLOUDFLARE_API_TOKEN}" | tr -d '[:space:]')"
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "::error::CLOUDFLARE_API_TOKEN is not set — cannot deploy. See docs/DEPLOY.md." >&2
  exit 1
fi

deploy() {
  local name="$1" config="$2"
  if [ ! -f "$config" ]; then
    echo "::error::missing wrangler config: $config" >&2
    exit 1
  fi
  echo "::group::deploy ${name}"
  # Retry once: transient CF API 5xx / rate-limit should not fail the whole run.
  if ! $WRANGLER deploy --config "$config"; then
    echo "first attempt failed, retrying ${name} in 8s..." >&2
    sleep 8
    $WRANGLER deploy --config "$config"
  fi
  echo "::endgroup::"
}

check() {
  local name="$1" url="$2" want="$3"
  echo "healthcheck: ${name} -> ${url} (expect HTTP ${want})"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --retry 6 --retry-delay 4 --retry-all-errors --max-time 25 "$url" || echo "000")
  if [ "$code" != "$want" ]; then
    echo "::error::${name} healthcheck FAILED: got HTTP ${code}, expected ${want} (${url})" >&2
    exit 1
  fi
  echo "  ok (HTTP ${code})"
}

# --- 1. foundation: identity-roster (org/user lookup; nothing else deployed yet) ---
deploy identity-roster services/identity-roster/wrangler.free.toml

# --- 2. auth-service (binds SVC_IDENTITY -> must follow identity-roster) ---
deploy auth-service services/auth-service/wrangler.free.toml

# --- 3. peripheral services (no cross Service Binding among them; order-free) ---
deploy event-service   services/event-service/wrangler.free.toml
deploy task-service    services/task-service/wrangler.free.toml
deploy gantt-service   services/gantt-service/wrangler.free.toml
deploy notification    services/notification/wrangler.free.toml
deploy file-meta       services/file-meta/wrangler.free.toml
deploy drive-proxy     services/drive-proxy/wrangler.free.toml
deploy chat-service    services/chat-service/wrangler.free.toml
deploy mail-gateway    services/mail-gateway/wrangler.free.toml
deploy deploy-service  services/deploy-service/wrangler.free.toml
deploy github-sync     services/github-sync/wrangler.free.toml
deploy audit-log       services/audit-log/wrangler.free.toml
# usage-meter binds SVC_IDENTITY (step 1) + SVC_NOTIFICATION/SVC_MAIL_GATEWAY (above), and is
# itself bound by api-gateway (SVC_USAGE_METER, step 4) — so it lands last in this tier, after
# its own upstreams exist and before the gateway that binds it. SQLite-DO alarm, no cron slot.
deploy usage-meter     services/usage-meter/wrangler.free.toml

# --- 4. api-gateway (binds all 15 upstreams — deploy only after they exist) ---
deploy api-gateway services/api-gateway/wrangler.free.toml

# --- 4b. gateway smoke — fail-fast BEFORE the public faces (fe2/mo3) go out ---
# This directly guards the incident that motivated auto-deploy: a merged+green
# change that never reached prod, surfacing as a 404 on gateway routes.
if [ "${SKIP_HEALTHCHECK:-0}" != "1" ]; then
  GW="${GATEWAY_HEALTH_URL:-https://dub-api-gateway.developershub-site.workers.dev}"
  GW="${GW%/}"
  # liveness: gateway is up and self-reports ok
  check "gateway /healthz" "${GW}/healthz" 200
  # routing: unauthenticated /api/v1/me must reach auth and return 401 (NOT 404).
  # A 404 here means the route regressed / gateway is stale — exactly the failure
  # mode this pipeline exists to catch.
  check "gateway /api/v1/me routing" "${GW}/api/v1/me" 401
fi

# --- 5. fe2 admin SPA (assets-only; built earlier with the prod API base URL) ---
deploy fe2-app-shell apps/fe2-app-shell/wrangler.free.toml

# --- 6. mo3 mobile BFF (binds SVC_AUTH/IDENTITY/EVENT/TASK/NOTIFICATION) ---
deploy mo3-mobile-bff apps/mo3-mobile-bff/wrangler.free.toml

# --- 6b. mobile-bff smoke (only when a public origin is configured) ---
if [ "${SKIP_HEALTHCHECK:-0}" != "1" ] && [ -n "${MOBILE_BFF_HEALTH_URL:-}" ]; then
  M="${MOBILE_BFF_HEALTH_URL%/}"
  check "mobile-bff /healthz" "${M}/healthz" 200
fi

echo "production deploy complete."
