#!/usr/bin/env bash
#
# promote-prod — the READ-ONLY preflight you run before asking the owner to promote a PR to
# production. It answers one question honestly: "is the build the owner verified on staging
# still the build this PR would ship?"
#
# IT NEVER PROMOTES ANYTHING. No merge, no label, no deploy — phase transitions
# (demo→staging, staging→本番, the `確認した` label, the main merge) are the owner's call
# only. This script exists purely to stop a promotion that is built on stale evidence.
#
# WHY (2026-09-29):
#   The owner reviewed PR #562 on staging at 15:01:21Z. At 15:14:56Z an unrelated PR (#561)
#   merged to main; staging.yml also fires on `push: main` and redeployed the SINGLE shared
#   staging slot from main's HEAD, silently evicting #562 13m35s later. The "確認した" the
#   owner was about to give would have referred to a URL that no longer served #562.
#
#   The guard that should have caught this — "the SHA on staging == the PR head SHA" — read
#   deploy-state/staging.json, which no workflow has ever written. It printed
#   "deployedSha がありません" and waved everything through. This script keeps the manifest as
#   the preferred source and FALLS BACK to the GitHub API (newest successful staging.yml run),
#   always naming which source produced the answer.
#
# Usage:
#   scripts/promote-prod.sh --pr <number> [--repo <owner/repo>] [--json]
#   scripts/promote-prod.sh --self-test        # offline; fixtures only
#
# Checks (all advisory-but-loud; none of them mutate anything):
#   1. staging occupancy — the SHA staging last served vs. this PR's head SHA.
#   2. Liveness-Marker   — present, and at least one marker is branch-unique vs. the
#                          merge-base with origin/main (a marker already on main proves
#                          nothing; see markers_base_unique in scripts/lib/promote-lib.sh).
#
# Exit codes: 0 = all guards satisfied · 3 = a guard FAILED (do not promote) ·
#             4 = a guard could not be evaluated (unknown — decide with a human) ·
#             2 = usage error.
#
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/promote-lib.sh
. "${ROOT}/scripts/lib/promote-lib.sh"

# ---- self-test (offline; fixtures for both seams) -----------------------------------
if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  fail=0
  PR_HEAD="cafebabecafebabecafebabecafebabecafebabe"

  printf '{"env":"staging","deployedSha":null}\n' > "$tmp/seed.json"
  printf '{"env":"staging","deployedSha":"%s"}\n' "$PR_HEAD" > "$tmp/match.json"
  cat > "$tmp/runs-main.json" <<'JSON'
[{"headBranch":"main","headSha":"2222222222222222222222222222222222222222","status":"completed","conclusion":"success","createdAt":"2026-09-29T15:14:56Z","event":"push"}]
JSON
  cat > "$tmp/runs-pr.json" <<JSON
[{"headBranch":"feat/x","headSha":"${PR_HEAD}","status":"completed","conclusion":"success","createdAt":"2026-09-29T15:01:21Z","event":"pull_request"}]
JSON

  # (a) manifest populated and matching -> occupied by this PR, source=manifest
  export PROMOTE_STAGING_MANIFEST="$tmp/match.json"
  unset PROMOTE_GH_RUNS_JSON
  resolve_staging_occupant >/dev/null 2>&1 || true
  if [ "$STAGING_OCCUPANT_SOURCE" = "manifest" ] && [ "$STAGING_OCCUPANT_SHA" = "$PR_HEAD" ]
    then echo "  ok  populated manifest is preferred and matches the PR head"
    else echo "  FAIL manifest path (src=$STAGING_OCCUPANT_SOURCE sha=$STAGING_OCCUPANT_SHA)"; fail=1; fi

  # (b) seed manifest + CI says main -> EVICTED (this is literally the #562 incident)
  export PROMOTE_STAGING_MANIFEST="$tmp/seed.json"
  export PROMOTE_GH_RUNS_JSON="$tmp/runs-main.json"
  resolve_staging_occupant >/dev/null 2>&1 || true
  if [ "$STAGING_OCCUPANT_SOURCE" = "ci-run" ] && [ "$STAGING_OCCUPANT_SHA" != "$PR_HEAD" ]
    then echo "  ok  seed manifest falls back to CI and detects the eviction"
    else echo "  FAIL fallback path (src=$STAGING_OCCUPANT_SOURCE sha=$STAGING_OCCUPANT_SHA)"; fail=1; fi

  # (c) seed manifest + CI says this PR -> still occupied, but sourced from CI
  export PROMOTE_GH_RUNS_JSON="$tmp/runs-pr.json"
  resolve_staging_occupant >/dev/null 2>&1 || true
  if [ "$STAGING_OCCUPANT_SOURCE" = "ci-run" ] && [ "$STAGING_OCCUPANT_SHA" = "$PR_HEAD" ]
    then echo "  ok  CI fallback confirms the PR still occupies staging"
    else echo "  FAIL fallback-match path (src=$STAGING_OCCUPANT_SOURCE sha=$STAGING_OCCUPANT_SHA)"; fail=1; fi

  # (d) no manifest, no runs -> UNKNOWN, and it must SAY so rather than pass silently
  printf '[]\n' > "$tmp/none.json"
  export PROMOTE_GH_RUNS_JSON="$tmp/none.json"
  rc=0; resolve_staging_occupant >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 1 ] && [ "$STAGING_OCCUPANT_SOURCE" = "unknown" ]
    then echo "  ok  no evidence is reported as UNKNOWN (never as OK)"
    else echo "  FAIL unknown path (rc=$rc src=$STAGING_OCCUPANT_SOURCE)"; fail=1; fi

  if [ "$fail" = 0 ]; then echo "promote-prod self-test: PASS"; exit 0
  else echo "promote-prod self-test: FAIL"; exit 1; fi
fi

# ---- args ---------------------------------------------------------------------------
PR=""; REPO="${GITHUB_REPOSITORY:-}"; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)   PR="${2:?--pr needs a number}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs owner/repo}"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[ -n "$PR" ] || { echo "::error::--pr <number> is required." >&2; exit 2; }
if [ -z "$REPO" ]; then
  REPO="$(git -C "$ROOT" remote get-url origin 2>/dev/null \
    | sed -E 's#^.*[:/]([^/:]+/[^/]+?)(\.git)?$#\1#')" || true
fi
[ -n "$REPO" ] || { echo "::error::could not resolve the repo; pass --repo owner/repo." >&2; exit 2; }

PR_JSON="$(gh pr view "$PR" --repo "$REPO" --json number,headRefOid,headRefName,body,labels 2>/dev/null || echo '')"
[ -n "$PR_JSON" ] || { echo "::error::could not read PR #${PR} from ${REPO}." >&2; exit 2; }

pr_field() { printf '%s' "$PR_JSON" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const j=JSON.parse(s); const v=j[process.argv[1]]; process.stdout.write(v==null?"":String(v)); }
    catch { process.stdout.write(""); }
  });' "$1"; }

PR_HEAD="$(pr_field headRefOid)"
PR_BRANCH="$(pr_field headRefName)"
PR_BODY="$(pr_field body)"

echo "promote-prod preflight — ${REPO}#${PR} (${PR_BRANCH})"
echo "  PR head: ${PR_HEAD}"
echo ""

# Severity is NOT numeric order: a FAILED guard (3) outranks an UNKNOWN one (4), because a
# proven-bad promotion is worse news than an unevaluated one. Track both, decide at the end.
GUARD_FAILED=0; GUARD_UNKNOWN=0
bump() { case "$1" in 3) GUARD_FAILED=1 ;; 4) GUARD_UNKNOWN=1 ;; esac; return 0; }

# ---- guard 1: staging occupancy ------------------------------------------------------
echo "[1/2] staging occupancy (is the reviewed build still on staging?)"
if resolve_staging_occupant "$REPO"; then
  echo "  source: ${STAGING_OCCUPANT_SOURCE} — ${STAGING_OCCUPANT_DETAIL}"
  echo "  staging serves: ${STAGING_OCCUPANT_SHA}${STAGING_OCCUPANT_BRANCH:+ (${STAGING_OCCUPANT_BRANCH})}"
  if [ "$STAGING_OCCUPANT_SHA" = "$PR_HEAD" ]; then
    echo "  ✅ staging still serves THIS PR's head."
  else
    echo "  ❌ EVICTED — staging no longer serves this PR. Any 確認 done on the staging URL"
    echo "     after that redeploy was performed against a DIFFERENT build."
    echo "     Re-apply the \`stagingへ\` label, let it redeploy, and re-verify before promoting."
    bump 3
  fi
else
  echo "  ⚠️  UNKNOWN — ${STAGING_OCCUPANT_DETAIL}"
  echo "     Cannot prove the reviewed build is still on staging. Decide with a human."
  bump 4
fi
echo ""

# ---- guard 2: Liveness-Marker is branch-unique ---------------------------------------
echo "[2/2] Liveness-Marker (does the marker actually distinguish this build?)"
MARKERS=(); MARKER_COUNT=0
while IFS= read -r m; do
  [ -n "$m" ] || continue
  MARKERS+=("$m"); MARKER_COUNT=$((MARKER_COUNT + 1))
done < <(printf '%s\n' "$PR_BODY" | parse_liveness_markers)

if [ "$MARKER_COUNT" -eq 0 ]; then
  echo "  ⚠️  no \`Liveness-Marker:\` trailer — the served bundle is never asserted for this PR."
  echo "     Fine for docs/chore; for a UI change add one (see .github/PULL_REQUEST_TEMPLATE.md)."
  bump 4
else
  BASE="$(git -C "$ROOT" merge-base "$PR_HEAD" origin/main 2>/dev/null || echo '')"
  if [ -z "$BASE" ]; then
    echo "  ⚠️  UNKNOWN — could not compute the merge-base with origin/main locally"
    echo "     (run \`git fetch origin main\` in a full clone). Marker uniqueness not checked."
    bump 4
  else
    rc=0
    ( cd "$ROOT" && markers_base_unique "$BASE" "${MARKERS[@]}" ) || rc=$?
    case "$rc" in
      0) echo "  ✅ at least one marker is branch-unique vs ${BASE}." ;;
      1) echo "  ❌ EVERY marker already exists on the base (${BASE})."
         echo "     Such a marker passes liveness against an UNCHANGED bundle — it proves nothing."
         echo "     Use a branch-unique string (a new data-testid, a new label)."
         bump 3 ;;
      *) echo "  ⚠️  UNKNOWN — could not evaluate marker uniqueness (rc=${rc})."; bump 4 ;;
    esac
  fi
fi
echo ""

VERDICT=0
if [ "$GUARD_FAILED" = 1 ]; then VERDICT=3
elif [ "$GUARD_UNKNOWN" = 1 ]; then VERDICT=4
fi

case "$VERDICT" in
  0) echo "PREFLIGHT OK — evidence is consistent. Promotion is still the OWNER's decision." ;;
  3) echo "PREFLIGHT FAILED — do NOT promote #${PR} to production on this evidence." ;;
  4) echo "PREFLIGHT UNKNOWN — a guard could not be evaluated. Do not treat this as a pass." ;;
esac

if [ "$JSON" = 1 ]; then
  printf '{"pr":%s,"head":"%s","stagingSource":"%s","stagingSha":"%s","verdict":%s}\n' \
    "$PR" "$PR_HEAD" "$STAGING_OCCUPANT_SOURCE" "$STAGING_OCCUPANT_SHA" "$VERDICT"
fi
exit "$VERDICT"
