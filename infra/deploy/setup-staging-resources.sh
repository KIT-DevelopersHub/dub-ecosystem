#!/usr/bin/env bash
#
# ONE-TIME staging bootstrap. Creates the dedicated staging D1 / KV / R2 resources (all free
# tier, $0), writes their ids into infra/deploy/staging-resources.env, applies the dub-core
# schema, and seeds representative DEMO data (NOT a copy of production — no real/PII data ever
# touches staging). Idempotent: re-running reuses existing resources.
#
# Run locally by the owner (or an agent on GO), NOT in the PR CI path:
#     export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)
#     bash infra/deploy/setup-staging-resources.sh
#
# See docs/runbooks/04-staging-label-gate.md §staging bootstrap.
set -euo pipefail

WRANGLER="pnpm dlx wrangler@4.35.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="infra/deploy/staging-resources.env"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "::error::CLOUDFLARE_API_TOKEN not set (export CLOUDFLARE_API_TOKEN=\$(cat ~/Desktop/cf-token.txt))." >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN="$(printf '%s' "${CLOUDFLARE_API_TOKEN}" | tr -d '[:space:]')"

set_env() {  # set_env KEY VALUE — replace the line in staging-resources.env
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # portable in-place edit (BSD + GNU sed): use a temp file
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
  echo "  ${key}=${val}"
}

d1_id() {  # d1_id NAME — echo the database id, creating the DB if absent
  local name="$1" id
  id="$($WRANGLER d1 list --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const a=JSON.parse(s);const m=a.find(x=>x.name===process.argv[1]);process.stdout.write(m?(m.uuid||m.id||""):"")}catch{process.stdout.write("")}
    })' "$name")"
  if [ -z "$id" ]; then
    $WRANGLER d1 create "$name" >/dev/null 2>&1 || true
    id="$($WRANGLER d1 list --json 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const a=JSON.parse(s);const m=a.find(x=>x.name===process.argv[1]);process.stdout.write(m?(m.uuid||m.id||""):"")}catch{process.stdout.write("")}
      })' "$name")"
  fi
  echo "$id"
}

kv_id() {  # kv_id TITLE — echo the namespace id, creating it if absent
  local title="$1" id
  id="$($WRANGLER kv namespace list 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const a=JSON.parse(s);const m=a.find(x=>x.title===process.argv[1]);process.stdout.write(m?m.id:"")}catch{process.stdout.write("")}
    })' "$title")"
  if [ -z "$id" ]; then
    $WRANGLER kv namespace create "$title" >/dev/null 2>&1 || true
    id="$($WRANGLER kv namespace list 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const a=JSON.parse(s);const m=a.find(x=>x.title===process.argv[1]);process.stdout.write(m?m.id:"")}catch{process.stdout.write("")}
      })' "$title")"
  fi
  echo "$id"
}

echo "== 1/4 D1 databases =="
set_env STAGING_DUB_CORE_D1_ID     "$(d1_id dub-core-staging)"
set_env STAGING_AUTH_OUTBOX_D1_ID  "$(d1_id auth-outbox-staging)"

echo "== 2/4 KV namespaces =="
set_env STAGING_AUTH_KV_ID         "$(kv_id auth-session-staging)"
set_env STAGING_DRIVE_PROXY_KV_ID  "$(kv_id drive-proxy-cache-staging)"
set_env STAGING_GANTT_KV_ID        "$(kv_id gantt-cache-staging)"

echo "== 3/4 R2 buckets (free tier; ignore 'already exists') =="
for b in dub-file-attachments-staging dub-mail-attachments-staging dub-r2-webhook-raw-staging; do
  $WRANGLER r2 bucket create "$b" >/dev/null 2>&1 || echo "  (bucket $b exists or R2 not enabled)"
  echo "  $b"
done

echo "== 4/4 schema + DEMO seed on dub-core-staging =="
# Build a fully-migrated + demo-seeded local SQLite using the repo's own migration/seed
# logic (the prod guard allows non-'dub-core' names), then push schema+data to the remote
# staging DB. This keeps the staging schema in lock-step with the app's real migrations
# without a remote migration runner. Representative demo data only — never prod data.
pnpm --filter @dub/infra-d1 run d1:reset >/dev/null
LOCAL_SQLITE="infra/d1/.wrangler/local-dub-core.sqlite"
if [ ! -f "$LOCAL_SQLITE" ]; then
  echo "::warning::local seed sqlite not found at ${LOCAL_SQLITE}; skipping remote seed (apply manually)."
else
  DUMP="$(mktemp -t staging-seed).sql"
  # Strip transaction/pragma wrappers; keep CREATE + INSERT (D1 execute runs multi-statement).
  sqlite3 "$LOCAL_SQLITE" .dump | grep -vE '^(PRAGMA |BEGIN TRANSACTION;|COMMIT;)' > "$DUMP"
  $WRANGLER d1 execute dub-core-staging --remote --file "$DUMP"
  rm -f "$DUMP"
fi

# auth-outbox-staging holds only the freeq outbox table (auth's OUTBOX_DB). Apply its DDL.
AUTH_OUTBOX_DDL="$(ls services/auth-service/db/*outbox*.sql 2>/dev/null | head -n1 || true)"
if [ -n "$AUTH_OUTBOX_DDL" ]; then
  $WRANGLER d1 execute auth-outbox-staging --remote --file "$AUTH_OUTBOX_DDL" || \
    echo "::warning::could not apply ${AUTH_OUTBOX_DDL} to auth-outbox-staging (apply manually)."
fi

echo
echo "staging bootstrap complete. Resource ids written to ${ENV_FILE}."
echo "Next: add the 「stagingへ」 label to a PR to deploy (or run: bash infra/deploy/deploy-staging.sh)."
