#!/usr/bin/env bash
#
# Ordered, dependency-safe STAGING deploy of the full Worker set — a like-for-like replica
# of production on dedicated `-staging` Workers + dedicated staging D1/KV/R2 ($0, free tier).
#
# Same deploy ORDER as production (infra/deploy/deploy-prod.sh); the only differences are
# the `-staging` Worker names and staging resource ids, both produced by
# gen-staging-configs.sh from each wrangler.free.toml. Called by .github/workflows/staging.yml
# after the fe2 bundle is built against the STAGING gateway URL.
#
# Requires in env: CLOUDFLARE_API_TOKEN (+ optional CLOUDFLARE_ACCOUNT_ID).
# Optional: SKIP_HEALTHCHECK=1
set -euo pipefail

WRANGLER="pnpm dlx wrangler@4.35.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
. infra/deploy/staging-worker-set.sh
set -a; . infra/deploy/staging-resources.env; set +a

# Same CF-credential whitespace scrub as deploy-prod.sh (a trailing space in the account id
# breaks the API URL path — see deploy-prod.sh for the full incident note).
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  export CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "${CLOUDFLARE_ACCOUNT_ID}" | tr -d '[:space:]')"
fi
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  export CLOUDFLARE_API_TOKEN="$(printf '%s' "${CLOUDFLARE_API_TOKEN}" | tr -d '[:space:]')"
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "::error::CLOUDFLARE_API_TOKEN is not set — cannot deploy staging." >&2
  exit 1
fi

# Fail fast if the staging resources were never bootstrapped (placeholder ids).
for v in STAGING_DUB_CORE_D1_ID STAGING_AUTH_OUTBOX_D1_ID STAGING_AUTH_KV_ID \
         STAGING_DRIVE_PROXY_KV_ID STAGING_GANTT_KV_ID; do
  case "${!v:-}" in
    ""|REPLACE_ME*)
      echo "::error::${v} is a placeholder. Bootstrap staging once: bash infra/deploy/setup-staging-resources.sh (see docs/runbooks/04-staging-label-gate.md)." >&2
      exit 1;;
  esac
done

# (Re)generate the staging configs from the current .free.toml topology + resource ids.
bash infra/deploy/gen-staging-configs.sh

deploy() {
  local config="$1"
  if [ ! -f "$config" ]; then echo "::error::missing $config" >&2; exit 1; fi
  echo "::group::deploy ${config}"
  if ! $WRANGLER deploy --config "$config"; then
    echo "first attempt failed, retrying in 8s..." >&2; sleep 8
    $WRANGLER deploy --config "$config"
  fi
  echo "::endgroup::"
}

check() {
  local name="$1" url="$2" want="$3" code
  echo "healthcheck: ${name} -> ${url} (expect HTTP ${want})"
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --retry 6 --retry-delay 4 --retry-all-errors --max-time 25 "$url" || echo "000")
  if [ "$code" != "$want" ]; then
    echo "::error::${name} staging healthcheck FAILED: got HTTP ${code}, expected ${want} (${url})" >&2
    exit 1
  fi
  echo "  ok (HTTP ${code})"
}

# Deploy every Worker in dependency order (identity -> auth -> peripherals -> api-gateway
# -> fe2 -> mo3 -> app-health-monitor). Gateway smoke runs right after the gateway, before
# the public faces — same fail-fast placement as prod.
GW="https://dub-api-gateway-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev"
for dir in "${STAGING_WORKER_DIRS[@]}"; do
  deploy "${dir}/wrangler.staging.toml"
  if [ "${dir}" = "services/api-gateway" ] && [ "${SKIP_HEALTHCHECK:-0}" != "1" ]; then
    check "staging gateway /healthz" "${GW}/healthz" 200
    check "staging gateway /api/v1/me" "${GW}/api/v1/me" 401
  fi
done

echo "staging deploy complete."
echo "  admin (fe2): https://dub-fe2-app-shell-staging.${STAGING_WORKERS_SUBDOMAIN}.workers.dev"
echo "  gateway:     ${GW}"
