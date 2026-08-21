#!/usr/bin/env bash
#
# teardown-demo — delete a disposable per-feature demo Worker (created by
# scripts/deploy-demo-feature.sh) and drop its manifest, so no orphan Workers accumulate
# against the free-plan script cap.
#
# WHY: each `dub-demo-<slug>` Worker occupies one of the account's limited Worker script
# slots. Once a feature's review is done its demo is dead weight — delete it and remove
# `deploy-state/demo-<slug>.json` so "what disposable demos exist" stays honest.
#
# Usage:
#   scripts/teardown-demo.sh <slug> [--keep-manifest] [--yes]
#   scripts/teardown-demo.sh gantt-marquee
#   scripts/teardown-demo.sh <slug> --dry-run     # print the plan, delete nothing
#   scripts/teardown-demo.sh --self-test          # offline logic check
#
#   <slug>          the feature slug used at deploy time (Worker = dub-demo-<slug>).
#   --keep-manifest delete the Worker but leave deploy-state/demo-<slug>.json (audit).
#   --dry-run       print what would be deleted; touch nothing.
#   --yes           skip the interactive confirmation (for CI / scripted teardown).
#
# Requires (real run): CLOUDFLARE_API_TOKEN in env.
# Exit codes: 0 ok · 2 usage · 1 env/delete error.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-+//; s/-+$//'
}
worker_name_for()   { printf 'dub-demo-%s' "$1"; }
manifest_path_for() { printf 'deploy-state/demo-%s.json' "$1"; }

# ---- self-test (no network) --------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fail=0
  [ "$(slugify 'Gantt Marquee')" = "gantt-marquee" ] || { echo "  FAIL slugify"; fail=1; }
  [ "$(worker_name_for foo)" = "dub-demo-foo" ] || { echo "  FAIL worker name"; fail=1; }
  [ "$(manifest_path_for foo)" = "deploy-state/demo-foo.json" ] || { echo "  FAIL manifest path"; fail=1; }
  if [ "$fail" = 0 ]; then echo "teardown-demo self-test: PASS"; exit 0
  else echo "teardown-demo self-test: FAIL"; exit 1; fi
fi

SLUG_RAW=""; KEEP_MANIFEST=0; DRY_RUN=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-manifest) KEEP_MANIFEST=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --yes|-y)        ASSUME_YES=1; shift ;;
    -h|--help)       sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --*)             echo "::error::unknown option '$1'" >&2; exit 2 ;;
    *)               [ -z "$SLUG_RAW" ] && SLUG_RAW="$1" || { echo "::error::unexpected arg '$1'" >&2; exit 2; }; shift ;;
  esac
done

[ -n "$SLUG_RAW" ] || { echo "::error::slug required: scripts/teardown-demo.sh <slug>" >&2; exit 2; }
SLUG="$(slugify "$SLUG_RAW")"
WORKER="$(worker_name_for "$SLUG")"
MANIFEST="$(manifest_path_for "$SLUG")"
cd "$ROOT"

echo "teardown plan:"
echo "  worker   : $WORKER  (delete)"
echo "  manifest : $MANIFEST  $([ "$KEEP_MANIFEST" = 1 ] && echo '(keep)' || echo '(remove)')"

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] would run: wrangler delete --name $WORKER"
  [ "$KEEP_MANIFEST" = 1 ] || echo "[dry-run] would remove: $MANIFEST"
  echo "[dry-run] nothing deleted."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf 'Delete Worker %s and its manifest? [y/N] ' "$WORKER"
  read -r ans || ans=""
  case "$ans" in y|Y|yes|YES) : ;; *) echo "aborted."; exit 0 ;; esac
fi

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::CLOUDFLARE_API_TOKEN not set. export CLOUDFLARE_API_TOKEN=\$(cat ~/Desktop/cf-token.txt)" >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | tr -d '[:space:]')"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && export CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | tr -d '[:space:]')"

echo "::group::wrangler delete $WORKER"
pnpm dlx wrangler@4.35.0 delete --name "$WORKER"
echo "::endgroup::"

if [ "$KEEP_MANIFEST" != 1 ] && [ -f "$MANIFEST" ]; then
  rm -f "$MANIFEST"
  echo "removed manifest: $MANIFEST"
fi

echo "torn down: $WORKER ✅  (commit the removal of $MANIFEST)."
