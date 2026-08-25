#!/usr/bin/env bash
#
# deploy-demo-feature — spin up a DISPOSABLE, per-feature demo Worker so reviewers can
# look at ONE feature in isolation without fighting over the single shared `fe2-demo` slot.
#
# WHY (the problem this solves):
#   `scripts/deploy-demo.sh` targets the ONE shared `fe2-demo` Worker. When many agents build
#   in parallel they serialize on that single slot — reviews queue, and a later deploy can
#   still clobber an earlier reviewer's build. For parallel development we instead want:
#   "base = main (or the agreed integration) + THIS ONE feature merged in" published to its
#   OWN throwaway Worker named `dub-demo-<slug>`, verified live, handed out as a shareable
#   URL, then torn down (`scripts/teardown-demo.sh <slug>`) once confirmed.
#
# CONSTRAINTS honored:
#   * 1 DEMO = 1 FEATURE. This script takes exactly one --slug and the marker(s) for that one
#     feature. Build the branch as main + that single feature BEFORE running it.
#   * FREE-TIER SAFE. Frontend + in-app mock/seed only (VITE_DEMO=1 baked in). No gateway,
#     no D1, no real backend is ever contacted — disposable demos cost nothing but a Worker
#     script slot, which teardown reclaims.
#   * NO SHARED-SLOT LOCK. Each demo has a unique Worker name, so per-feature demos never
#     clobber each other — no machine-wide lock needed (unlike deploy-demo.sh).
#
# Usage:
#   scripts/deploy-demo-feature.sh --slug <feature-slug> --markers "<m1>[,<m2>...]" [--note "<t>"]
#   scripts/deploy-demo-feature.sh --slug gantt-marquee --markers 'data-testid="gantt-marquee"'
#   scripts/deploy-demo-feature.sh --self-test          # no network/wrangler; logic check
#   scripts/deploy-demo-feature.sh --slug x --markers y --dry-run   # print plan, deploy nothing
#
#   --slug      REQUIRED. Short id for THIS feature. Slugified to [a-z0-9-]; the Worker is
#               `dub-demo-<slug>` and the manifest `deploy-state/demo-<slug>.json`.
#   --markers   REQUIRED. Comma-separated feature-unique strings that MUST appear in the
#               served bundle (a data-testid, a unique label, a build stamp).
#   --note      optional free-text stored in the manifest.
#   --no-build  skip the Vite build (reuse the existing apps/fe2-app-shell/dist).
#   --dry-run   resolve names/URL and print the plan; do NOT build, deploy, or write anything.
#   --self-test offline assertions (slugify / worker name / manifest JSON); no network.
#
# Requires (real run): CLOUDFLARE_API_TOKEN in env
#   export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)
#
# Exit codes: 0 ok · 2 usage · 1 env/deploy · 3 not-live (markers missing in served bundle).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBDOMAIN_DEFAULT="developershub-site"
# Warn once the number of live disposable demos gets close to a comfortable ceiling. The
# Cloudflare free plan caps Worker scripts per account (~100); each disposable demo eats one
# until torn down. This keeps parallel demos from silently exhausting the account.
DEMO_SOFT_LIMIT="${DEMO_SOFT_LIMIT:-20}"

resolve_subdomain() {
  local envfile="${ROOT}/infra/deploy/staging-resources.env" sub=""
  if [ -f "$envfile" ]; then
    sub="$(awk -F= '/^STAGING_WORKERS_SUBDOMAIN=/{print $2; exit}' "$envfile" | tr -d '[:space:]')"
  fi
  printf '%s' "${sub:-$SUBDOMAIN_DEFAULT}"
}

# feature id -> safe slug: lowercase, non-alnum -> '-', collapse/trim '-'.
slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-+//; s/-+$//'
}
worker_name_for() { printf 'dub-demo-%s' "$1"; }              # slug -> Worker name
manifest_path_for() { printf 'deploy-state/demo-%s.json' "$1"; }  # slug -> manifest file
url_for() { printf 'https://dub-demo-%s.%s.workers.dev' "$1" "$(resolve_subdomain)"; }

# markers CSV -> global MARKERS array (trim spaces around commas)
parse_markers() {
  local csv="$1"; MARKERS=()
  IFS=',' read -r -a MARKERS <<< "$csv"
  local i
  for i in "${!MARKERS[@]}"; do
    MARKERS[$i]="$(printf '%s' "${MARKERS[$i]}" | sed 's/^ *//;s/ *$//')"
  done
}

# emit a JSON array of the current MARKERS (pure bash, no jq)
markers_json() {
  local out="" m first=1
  for m in "${MARKERS[@]}"; do
    m="${m//\\/\\\\}"; m="${m//\"/\\\"}"
    if [ "$first" = 1 ]; then out="\"$m\""; first=0; else out="$out,\"$m\""; fi
  done
  printf '[%s]' "$out"
}

write_manifest() {  # path slug worker url sha branch actor live note
  local path="$1" slug="$2" worker="$3" url="$4" sha="$5" branch="$6" actor="$7" live="$8" note="$9"
  local now; now="$(date -u +%FT%TZ)"
  local ne="${note//\\/\\\\}"; ne="${ne//\"/\\\"}"
  cat > "$path" <<JSON
{
  "kind": "demo-feature",
  "slug": "$slug",
  "worker": "$worker",
  "url": "$url",
  "deployedSha": "$sha",
  "branch": "$branch",
  "actor": "$actor",
  "markers": $(markers_json),
  "live": $live,
  "verifiedAt": "$now",
  "updatedAt": "$now",
  "note": "$ne"
}
JSON
}

# ---- self-test (no network/wrangler) ----------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fail=0
  [ "$(slugify 'Gantt Marquee!!')" = "gantt-marquee" ] || { echo "  FAIL slugify spaces/punct"; fail=1; }
  [ "$(slugify 'PR#412_range--select')" = "pr-412-range-select" ] || { echo "  FAIL slugify collapse"; fail=1; }
  [ "$(slugify '--Lead-')" = "lead" ] || { echo "  FAIL slugify trim"; fail=1; }
  [ "$(worker_name_for gantt-marquee)" = "dub-demo-gantt-marquee" ] || { echo "  FAIL worker name"; fail=1; }
  [ "$(manifest_path_for foo)" = "deploy-state/demo-foo.json" ] || { echo "  FAIL manifest path"; fail=1; }
  case "$(url_for foo)" in https://dub-demo-foo.*.workers.dev) : ;; *) echo "  FAIL url"; fail=1 ;; esac
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  parse_markers 'a, b ,c'
  [ "${#MARKERS[@]}" = 3 ] && [ "${MARKERS[1]}" = "b" ] || { echo "  FAIL parse_markers"; fail=1; }
  [ "$(markers_json)" = '["a","b","c"]' ] || { echo "  FAIL markers_json"; fail=1; }
  write_manifest "$tmp/m.json" foo dub-demo-foo https://x abc123 br me true "note \"q\""
  grep -q '"slug": "foo"' "$tmp/m.json" && grep -q '"live": true' "$tmp/m.json" || { echo "  FAIL manifest write"; fail=1; }
  grep -q '"kind": "demo-feature"' "$tmp/m.json" || { echo "  FAIL manifest kind"; fail=1; }
  if [ "$fail" = 0 ]; then echo "deploy-demo-feature self-test: PASS"; exit 0
  else echo "deploy-demo-feature self-test: FAIL"; exit 1; fi
fi

# ---- args --------------------------------------------------------------------------
SLUG_RAW=""; MARKERS_CSV=""; NOTE=""; DO_BUILD=1; DRY_RUN=0
declare -a MARKERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)     SLUG_RAW="${2:?}"; shift 2 ;;
    --markers)  MARKERS_CSV="${2:?}"; shift 2 ;;
    --note)     NOTE="${2:-}"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,48p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done

[ -n "$SLUG_RAW" ]    || { echo "::error::--slug is required (short id for THIS one feature, e.g. --slug gantt-marquee)." >&2; exit 2; }
[ -n "$MARKERS_CSV" ] || { echo "::error::--markers is required (feature-unique string proving the build is live)." >&2; exit 2; }

SLUG="$(slugify "$SLUG_RAW")"
[ -n "$SLUG" ] || { echo "::error::--slug '$SLUG_RAW' slugifies to empty; use letters/digits." >&2; exit 2; }
WORKER="$(worker_name_for "$SLUG")"
# Cloudflare Worker script names must be <=63 chars, [a-z0-9-].
if [ "${#WORKER}" -gt 63 ]; then
  echo "::error::worker name '$WORKER' is ${#WORKER} chars (>63). Use a shorter --slug." >&2; exit 2
fi
URL="$(url_for "$SLUG")"
MANIFEST="$(manifest_path_for "$SLUG")"
parse_markers "$MARKERS_CSV"

SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
ACTOR="${GITHUB_ACTOR:-$(git -C "$ROOT" config user.name 2>/dev/null || echo "${USER:-unknown}")}"

cd "$ROOT"

# Free-tier awareness: count existing disposable-demo manifests.
existing="$(find deploy-state -maxdepth 1 -name 'demo-*.json' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$existing" -ge "$DEMO_SOFT_LIMIT" ]; then
  echo "::warning::${existing} disposable demos already recorded (soft limit ${DEMO_SOFT_LIMIT}). Tear down confirmed ones with scripts/teardown-demo.sh <slug> to stay under the free Worker cap."
fi

echo "feature demo plan:"
echo "  slug     : $SLUG"
echo "  worker   : $WORKER"
echo "  url      : $URL"
echo "  manifest : $MANIFEST"
echo "  markers  : ${MARKERS[*]}"
echo "  sha/branch: $SHA / $BRANCH   actor: $ACTOR"

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  echo "[dry-run] would build (VITE_DEMO=1) : $([ "$DO_BUILD" = 1 ] && echo yes || echo 'no (--no-build)')"
  echo "[dry-run] would deploy              : wrangler deploy --config apps/fe2-app-shell/wrangler.demo.toml --name $WORKER"
  echo "[dry-run] would verify              : scripts/verify-live.sh --url $URL/ ${MARKERS[*]}"
  echo "[dry-run] would write manifest      : $MANIFEST"
  echo "[dry-run] nothing was built, deployed, or written."
  exit 0
fi

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::CLOUDFLARE_API_TOKEN not set. export CLOUDFLARE_API_TOKEN=\$(cat ~/Desktop/cf-token.txt)" >&2; exit 1; }

# ---- build (demo transport baked in via VITE_DEMO=1) -------------------------------
if [ "$DO_BUILD" = 1 ]; then
  echo "::group::build fe2 (VITE_DEMO=1)"
  VITE_DEMO=1 pnpm --filter @dub/fe2-app-shell build
  echo "::endgroup::"
fi
DIST="apps/fe2-app-shell/dist"

# Fail BEFORE deploying if the markers aren't even in the freshly built bundle.
echo "::group::pre-deploy check (built dist)"
built_ok=1
for m in "${MARKERS[@]}"; do
  if grep -rqF -- "$m" "$DIST" 2>/dev/null; then echo "  ✓ in dist  $m"; else echo "  ✗ NOT in dist  $m"; built_ok=0; fi
done
echo "::endgroup::"
[ "$built_ok" = 1 ] || { echo "::error::marker(s) not in built bundle ($DIST). The feature isn't in this build — fix code/build. Nothing deployed." >&2; exit 3; }

# ---- deploy to the UNIQUE per-feature Worker (name override) ------------------------
echo "::group::wrangler deploy $WORKER"
export CLOUDFLARE_API_TOKEN="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | tr -d '[:space:]')"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && export CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "$CLOUDFLARE_ACCOUNT_ID" | tr -d '[:space:]')"
pnpm dlx wrangler@4.35.0 deploy --config apps/fe2-app-shell/wrangler.demo.toml --name "$WORKER"
echo "::endgroup::"

# ---- liveness: assert the served per-feature Worker really contains the feature -----
echo "::group::post-deploy liveness (served $URL)"
if bash scripts/verify-live.sh --url "$URL/" "${MARKERS[@]}"; then live=true; else live=false; fi
# also fetch the referenced asset bundles for a thorough check (feature code lives in JS)
echo "::endgroup::"

write_manifest "$MANIFEST" "$SLUG" "$WORKER" "$URL" "$SHA" "$BRANCH" "$ACTOR" "$live" "$NOTE"
echo "manifest written: $MANIFEST (live=$live)"

if [ "$live" != true ]; then
  echo "::error::feature demo NOT live for the given markers — do NOT ask anyone to 確認して. (wrong build? cache? deploy failed?)" >&2
  exit 3
fi

echo ""
echo "feature demo LIVE ✅  $URL  (slug $SLUG, sha $SHA, by $ACTOR)"
echo "Share this URL for review. When confirmed, tear it down: scripts/teardown-demo.sh $SLUG"
echo "Commit $MANIFEST so the disposable demo is recorded."
