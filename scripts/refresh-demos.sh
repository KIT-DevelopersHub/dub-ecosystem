#!/usr/bin/env bash
#
# refresh-demos — rebuild every per-feature demo on a FRESH `main` base so the surrounding
# UI (everything the reviewer is NOT reviewing) is always the current production/staging
# state, never the stale snapshot the feature branch was cut from.
#
# WHY (the problem this solves — 判断87):
#   A per-feature demo is `dub-demo-<slug>` built by scripts/deploy-demo-feature.sh. Because
#   fe2-app-shell BUNDLES every micro-frontend (@dub/ui, fe3/fe4/fe5/fe6/fe7 …) into ONE SPA,
#   a demo built straight off an OLD feature branch also ships that branch's OLD copy of all
#   the OTHER features — so the reviewer sees "UI が全体的に古い". The fix is to always build
#   `main + THIS one feature` so only the feature under review differs from live main.
#   This script re-bases each registered demo onto the latest `main` and redeploys it, so the
#   whole fleet of demos periodically absorbs the newest main (= prod/staging) state.
#
# WHAT it does, per registered demo {slug, ref, markers}:
#   1. in a DEDICATED throwaway git worktree (never your checkout): reset to origin/main,
#      then `git merge origin/<ref>` → the exact "main + feature" tree.
#   2. `pnpm install` (store-backed, fast) so the workspace builds.
#   3. hand off to scripts/deploy-demo-feature.sh --slug <slug> --markers <markers>, which
#      builds VITE_DEMO=1, fails if the markers aren't in the freshly built bundle, deploys
#      the disposable `dub-demo-<slug>` Worker, and verify-live-checks the SERVED bundle.
#   4. copy the resulting deploy-state/demo-<slug>.json manifest back into this repo.
#   A merge conflict / missing branch / dead liveness is reported and SKIPPED — a broken demo
#   is never handed out (壊れたデモは配らない).
#
# The registry (deploy-state/demo-registry.json) is the single list of demos to keep fresh.
# Add a demo once; every scheduled refresh rebuilds it on the newest main automatically.
#
# CONSTRAINTS honored:
#   * per-feature demos only (backend-free, VITE_DEMO=1) — no staging/prod is ever touched.
#   * NON-DESTRUCTIVE to your working copy — all git happens in a separate worktree.
#   * FREE-TIER SAFE — reuses the same `dub-demo-<slug>` Worker names (URLs unchanged), so a
#     refresh overwrites in place and never multiplies Worker slots.
#
# Usage:
#   scripts/refresh-demos.sh                       # refresh every demo in the registry
#   scripts/refresh-demos.sh --only tab-anim       # just one slug (repeatable)
#   scripts/refresh-demos.sh --dry-run             # print the plan; no git/build/deploy
#   scripts/refresh-demos.sh --no-deploy           # rebuild + verify dist OFFLINE (no CF, no URL)
#   scripts/refresh-demos.sh --self-test           # offline registry/plan logic check
#   scripts/refresh-demos.sh --registry <file>     # use an alternate registry
#   scripts/refresh-demos.sh --base <ref>          # re-base on <ref> instead of origin/main
#   scripts/refresh-demos.sh --keep-worktree       # leave the scratch worktree for inspection
#
# Requires (real run): CLOUDFLARE_API_TOKEN in env (skip with --no-deploy / --dry-run).
#   export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)
#
# Exit codes: 0 all refreshed · 2 usage · 1 env/setup · 5 one or more demos failed to refresh.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY_DEFAULT="deploy-state/demo-registry.json"
BASE_REF_DEFAULT="origin/main"
# A dedicated, reusable scratch worktree keeps node_modules warm between runs (fast on the
# non-power PC) and guarantees we never disturb the user's checkout or its branch.
WT_DIR_DEFAULT="${DUB_REFRESH_WT:-${TMPDIR:-/tmp}/dub-refresh-demos-wt}"

# --- tiny JSON-array reader (pure bash/grep — no jq dependency, matching sibling scripts) ---
# Extracts the value of a string field from each top-level {...} object block in the registry.
# The registry format is intentionally simple/flat so this stays dependency-free (see
# --self-test for the exact contract).
registry_slugs() { grep -oE '"slug"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" | sed -E 's/.*"([^"]*)"$/\1/'; }
field_for_slug() { # file slug field -> value  (reads the object whose slug matches)
  awk -v want="$2" -v field="$3" '
    /\{/ { obj=""; depth=1 }
    { obj = obj $0 "\n" }
    /\}/ {
      if (obj ~ "\"slug\"[ \t]*:[ \t]*\"" want "\"") {
        if (match(obj, "\"" field "\"[ \t]*:[ \t]*\"[^\"]*\"")) {
          s = substr(obj, RSTART, RLENGTH); sub(/^[^:]*:[ \t]*"/, "", s); sub(/"$/, "", s); print s
        }
        exit
      }
    }' "$1"
}

# ---- self-test (no network / no git / no wrangler) --------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fail=0
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/reg.json" <<'JSON'
{
  "demos": [
    { "slug": "tab-anim",  "ref": "fe7/microanim-a01a03-core", "markers": "toastInFade",           "note": "A01-A03" },
    { "slug": "notif-ui",  "ref": "fe/notif-ui-fixes",         "markers": "一括既読,添付",          "note": "notif" }
  ]
}
JSON
  got="$(registry_slugs "$tmp/reg.json" | tr '\n' ',' )"
  [ "$got" = "tab-anim,notif-ui," ] || { echo "  FAIL slug list: '$got'"; fail=1; }
  [ "$(field_for_slug "$tmp/reg.json" tab-anim ref)" = "fe7/microanim-a01a03-core" ] || { echo "  FAIL ref lookup"; fail=1; }
  [ "$(field_for_slug "$tmp/reg.json" tab-anim markers)" = "toastInFade" ] || { echo "  FAIL markers lookup"; fail=1; }
  [ "$(field_for_slug "$tmp/reg.json" notif-ui markers)" = "一括既読,添付" ] || { echo "  FAIL multi-marker lookup"; fail=1; }
  [ -z "$(field_for_slug "$tmp/reg.json" nope ref)" ] || { echo "  FAIL unknown slug should be empty"; fail=1; }
  if [ "$fail" = 0 ]; then echo "refresh-demos self-test: PASS"; exit 0
  else echo "refresh-demos self-test: FAIL"; exit 1; fi
fi

# ---- args ------------------------------------------------------------------------------
REGISTRY="$REGISTRY_DEFAULT"; BASE_REF="$BASE_REF_DEFAULT"; DRY_RUN=0; NO_DEPLOY=0
KEEP_WT=0; WT_DIR="$WT_DIR_DEFAULT"
declare -a ONLY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only)         ONLY+=("${2:?}"); shift 2 ;;
    --registry)     REGISTRY="${2:?}"; shift 2 ;;
    --base)         BASE_REF="${2:?}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --no-deploy)    NO_DEPLOY=1; shift ;;
    --keep-worktree) KEEP_WT=1; shift ;;
    -h|--help)      sed -n '2,52p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cd "$ROOT"
[ -f "$REGISTRY" ] || { echo "::error::registry not found: $REGISTRY" >&2; exit 2; }

# select slugs: all in registry, or the --only subset (validated against the registry).
# (read loop instead of `mapfile` so this runs on macOS's stock bash 3.2.)
ALL_SLUGS=()
while IFS= read -r line; do [ -n "$line" ] && ALL_SLUGS+=("$line"); done < <(registry_slugs "$REGISTRY")
[ "${#ALL_SLUGS[@]}" -gt 0 ] || { echo "::error::no demos in registry $REGISTRY" >&2; exit 2; }
if [ "${#ONLY[@]}" -gt 0 ]; then
  declare -a SLUGS=()
  for want in "${ONLY[@]}"; do
    found=0; for s in "${ALL_SLUGS[@]}"; do [ "$s" = "$want" ] && { SLUGS+=("$s"); found=1; }; done
    [ "$found" = 1 ] || { echo "::error::--only '$want' is not in $REGISTRY (have: ${ALL_SLUGS[*]})" >&2; exit 2; }
  done
else
  SLUGS=("${ALL_SLUGS[@]}")
fi

echo "refresh-demos plan:"
echo "  registry : $REGISTRY"
echo "  base     : $BASE_REF   (each demo = base + its feature ref)"
echo "  demos    : ${SLUGS[*]}"
echo "  worktree : $WT_DIR"
echo "  mode     : $([ "$DRY_RUN" = 1 ] && echo dry-run || { [ "$NO_DEPLOY" = 1 ] && echo 'rebuild+verify-dist (no deploy)' || echo 'rebuild+deploy+verify-live'; })"
for s in "${SLUGS[@]}"; do
  printf '   - %-18s ref=%-32s markers=%s\n' "$s" "$(field_for_slug "$REGISTRY" "$s" ref)" "$(field_for_slug "$REGISTRY" "$s" markers)"
done

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  echo "[dry-run] would, for each demo: worktree reset to $BASE_REF → merge its ref → pnpm install →"
  echo "[dry-run]   deploy-demo-feature.sh --slug <slug> --markers <markers> → copy demo-<slug>.json back."
  echo "[dry-run] nothing fetched, built, deployed, or written."
  exit 0
fi

if [ "$NO_DEPLOY" = 0 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "::error::CLOUDFLARE_API_TOKEN not set (needed to deploy). export CLOUDFLARE_API_TOKEN=\$(cat ~/Desktop/cf-token.txt), or pass --no-deploy to only rebuild+verify the bundle." >&2
  exit 1
fi

command -v git >/dev/null || { echo "::error::git not found" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "::error::pnpm not found" >&2; exit 1; }

echo "::group::fetch origin"
git fetch origin --prune
echo "::endgroup::"

# --- prepare the dedicated scratch worktree (create once, reuse thereafter) --------------
# prune first so a previously-removed-but-still-registered path (e.g. after --keep-worktree
# on a symlinked /tmp) never blocks re-creation; `-f` overrides a stale registration.
git worktree prune
if [ -e "$WT_DIR/.git" ]; then
  echo "reusing scratch worktree $WT_DIR"
else
  rm -rf "$WT_DIR"
  echo "creating scratch worktree $WT_DIR"
  git worktree add -f --detach "$WT_DIR" "$BASE_REF" >/dev/null
fi

cleanup_wt() { [ "$KEEP_WT" = 1 ] || git worktree remove --force "$WT_DIR" >/dev/null 2>&1 || true; }
trap cleanup_wt EXIT

declare -a OK=() FAILED=()

for slug in "${SLUGS[@]}"; do
  ref="$(field_for_slug "$REGISTRY" "$slug" ref)"
  markers="$(field_for_slug "$REGISTRY" "$slug" markers)"
  note="$(field_for_slug "$REGISTRY" "$slug" note)"
  echo ""
  echo "==================================================================="
  echo "refreshing demo '$slug'  (ref=$ref  markers=$markers)"
  echo "==================================================================="
  if [ -z "$ref" ] || [ -z "$markers" ]; then
    echo "::error::registry entry for '$slug' is missing ref/markers — skipping." >&2
    FAILED+=("$slug (bad registry entry)"); continue
  fi

  # 1) rebuild the "base + feature" tree in the scratch worktree ------------------------
  git -C "$WT_DIR" merge --abort >/dev/null 2>&1 || true
  git -C "$WT_DIR" reset --hard "$BASE_REF" >/dev/null
  git -C "$WT_DIR" clean -fdx -e node_modules -e '**/node_modules' >/dev/null 2>&1 || true
  if ! git -C "$WT_DIR" cat-file -e "origin/${ref}^{commit}" 2>/dev/null; then
    echo "::error::branch origin/$ref not found — skipping '$slug'." >&2
    FAILED+=("$slug (no branch origin/$ref)"); continue
  fi
  if ! git -C "$WT_DIR" merge --no-edit --no-ff "origin/$ref" >/dev/null 2>&1; then
    git -C "$WT_DIR" merge --abort >/dev/null 2>&1 || true
    echo "::error::'$ref' does NOT merge cleanly onto $BASE_REF — feature needs a rebase. Skipping '$slug'." >&2
    FAILED+=("$slug (merge conflict on $BASE_REF)"); continue
  fi
  base_sha="$(git -C "$WT_DIR" rev-parse --short "$BASE_REF")"
  echo "  tree = $BASE_REF ($base_sha) + origin/$ref  ✓"

  # 2) install workspace deps (store-backed → fast) ------------------------------------
  echo "::group::pnpm install ($slug)"
  ( cd "$WT_DIR" && pnpm install --prefer-offline --config.confirmModulesPurge=false ) \
    || { echo "::error::pnpm install failed for '$slug' — skipping." >&2; FAILED+=("$slug (pnpm install)"); echo "::endgroup::"; continue; }
  echo "::endgroup::"

  # Build fe2's workspace DEPENDENCIES first (@dub/tokens/ui/…, fe3-fe7). fe2's own build is
  # a standalone `pnpm --filter @dub/fe2-app-shell build` that assumes these dist/ outputs
  # (e.g. @dub/tokens/tokens.css) already exist — in a fresh worktree they don't. `^...`
  # selects the dependency graph of fe2-app-shell WITHOUT fe2 itself.
  echo "::group::build deps ($slug)"
  ( cd "$WT_DIR" && pnpm --filter "@dub/fe2-app-shell^..." build ) \
    || { echo "::error::dependency build failed for '$slug' — skipping." >&2; FAILED+=("$slug (deps build)"); echo "::endgroup::"; continue; }
  echo "::endgroup::"

  # The scratch tree is `main + feature`; the deploy tooling itself is NOT on main, so make
  # the worktree self-sufficient by copying the sanctioned scripts in from THIS repo. (They
  # are recreated every iteration because the reset --hard above wipes them.)
  mkdir -p "$WT_DIR/scripts" "$WT_DIR/deploy-state"
  cp "$ROOT/scripts/deploy-demo-feature.sh" "$ROOT/scripts/verify-live.sh" "$WT_DIR/scripts/"

  # 3) build + (deploy) + verify via the sanctioned per-feature tool --------------------
  if [ "$NO_DEPLOY" = 1 ]; then
    echo "::group::offline rebuild+verify ($slug)"
    ok=1
    ( cd "$WT_DIR" && VITE_DEMO=1 pnpm --filter @dub/fe2-app-shell build ) || ok=0
    if [ "$ok" = 1 ]; then
      IFS=',' read -r -a marr <<< "$markers"; for i in "${!marr[@]}"; do marr[$i]="$(printf '%s' "${marr[$i]}" | sed 's/^ *//;s/ *$//')"; done
      dist="$WT_DIR/apps/fe2-app-shell/dist"
      for m in "${marr[@]}"; do
        if grep -rqF -- "$m" "$dist" 2>/dev/null; then echo "  ✓ in dist  $m"; else echo "  ✗ NOT in dist  $m"; ok=0; fi
      done
    fi
    echo "::endgroup::"
    [ "$ok" = 1 ] && OK+=("$slug (dist-verified, not deployed)") || FAILED+=("$slug (build/marker)")
    continue
  fi

  echo "::group::deploy-demo-feature ($slug)"
  set +e
  ( cd "$WT_DIR" && CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
      bash scripts/deploy-demo-feature.sh --slug "$slug" --markers "$markers" \
        --note "refresh-demos: ${BASE_REF}(${base_sha})+${ref}${note:+ — $note}" )
  rc=$?
  set -e
  echo "::endgroup::"

  if [ "$rc" -eq 0 ]; then
    # copy the fresh manifest back into THIS repo so the recorded live-state is current.
    if [ -f "$WT_DIR/deploy-state/demo-$slug.json" ]; then
      cp "$WT_DIR/deploy-state/demo-$slug.json" "$ROOT/deploy-state/demo-$slug.json"
    fi
    url="$(grep -oE '"url"[^,]*' "$ROOT/deploy-state/demo-$slug.json" 2>/dev/null | head -1 | sed -E 's/.*"(https[^"]*)".*/\1/')"
    OK+=("$slug -> ${url:-deployed}")
  else
    FAILED+=("$slug (deploy/liveness rc=$rc)")
  fi
done

# ---- summary --------------------------------------------------------------------------
echo ""
echo "==================== refresh-demos summary ===================="
if [ "${#OK[@]}" -gt 0 ];     then for x in "${OK[@]}";     do echo "  ✅ $x"; done; fi
if [ "${#FAILED[@]}" -gt 0 ]; then for x in "${FAILED[@]}"; do echo "  ❌ $x"; done; fi
echo "==============================================================="
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "::error::${#FAILED[@]} demo(s) failed to refresh — do NOT hand out their URLs until fixed." >&2
  exit 5
fi
echo "all ${#OK[@]} demo(s) refreshed on ${BASE_REF}. URLs unchanged; commit deploy-state/demo-*.json."
exit 0
