#!/usr/bin/env bash
#
# cleanup-demos — automatically delete per-feature demo Workers (`dub-demo-<slug>`) whose
# review is over, so they stop eating the free plan's 100-Worker cap.
#
# WHY: teardown-demo.sh only runs when someone remembers to. In practice demos pile up
# (21 live on 2026-10-10, most for already-merged PRs) and crowd out room for more staging
# slots. This sweeps them by rule instead of by memory.
#
# Rule per `dub-demo-*` Worker (the Cloudflare Worker list is the source of truth):
#   PR OPEN              -> keep   (still under review)
#   PR MERGED / CLOSED   -> delete (review finished)
#   no PR found          -> delete only if not redeployed for --stale-days (default 14)
# The PR is resolved from deploy-state/demo-registry.json (`pr`) first, else from the
# manifest's `branch` (deploy-state/demo-<slug>.json) via `gh pr list --head`.
# Workers NOT named `dub-demo-*` are never touched.
#
# Usage:
#   scripts/cleanup-demos.sh --dry-run                 # print the plan, delete nothing
#   scripts/cleanup-demos.sh --yes                     # delete (CI)
#   scripts/cleanup-demos.sh --yes --branch feat/x     # only demos built from branch feat/x
#   scripts/cleanup-demos.sh --stale-days 7 --dry-run
#   scripts/cleanup-demos.sh --self-test               # offline decision-logic check
#
# Requires (real run): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, an authenticated `gh`.
# Exit codes: 0 ok · 2 usage · 1 env/delete error.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="dub-demo-"

# decide <pr_state> <age_days> <stale_days>  ->  "delete <reason>" | "keep <reason>"
decide() {
  local state="$1" age="$2" stale="$3"
  case "$state" in
    OPEN)          echo "keep PR open" ;;
    MERGED|CLOSED) echo "delete PR $(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')" ;;
    *) if [ "$age" -ge "$stale" ]; then echo "delete no PR, idle ${age}d"
       else echo "keep no PR, idle ${age}d < ${stale}d"; fi ;;
  esac
}

# Collapse several PR states for one branch: any OPEN wins, then MERGED, then CLOSED.
collapse_states() {
  local s; s="$(cat)"
  if   grep -qx OPEN   <<<"$s"; then echo OPEN
  elif grep -qx MERGED <<<"$s"; then echo MERGED
  elif grep -qx CLOSED <<<"$s"; then echo CLOSED
  else echo NONE; fi
}

if [ "${1:-}" = "--self-test" ]; then
  fail=0
  t() { local got; got="$(decide "$1" "$2" "$3")"; [ "${got%% *}" = "$4" ] || { echo "  FAIL decide $1 $2 $3 -> $got (want $4)"; fail=1; }; }
  t OPEN   99 14 keep
  t MERGED  0 14 delete
  t CLOSED  0 14 delete
  t NONE   14 14 delete
  t NONE   13 14 keep
  [ "$(printf 'CLOSED\nOPEN\n' | collapse_states)" = OPEN ]    || { echo "  FAIL collapse open"; fail=1; }
  [ "$(printf 'CLOSED\nMERGED\n' | collapse_states)" = MERGED ] || { echo "  FAIL collapse merged"; fail=1; }
  [ "$(printf '' | collapse_states)" = NONE ]                    || { echo "  FAIL collapse none"; fail=1; }
  if [ "$fail" = 0 ]; then echo "cleanup-demos self-test: PASS"; exit 0
  else echo "cleanup-demos self-test: FAIL"; exit 1; fi
fi

DRY_RUN=0; ASSUME_YES=0; STALE_DAYS=14; ONLY_BRANCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --stale-days) STALE_DAYS="${2:?}"; shift 2 ;;
    --branch)     ONLY_BRANCH="${2:?}"; shift 2 ;;
    -h|--help)    sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)            echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[ "$DRY_RUN" = 1 ] || [ "$ASSUME_YES" = 1 ] || { echo "::error::pass --dry-run or --yes" >&2; exit 2; }

cd "$ROOT"
TOKEN="$(printf '%s' "${CLOUDFLARE_API_TOKEN:-}" | tr -d '[:space:]')"
ACCOUNT="$(printf '%s' "${CLOUDFLARE_ACCOUNT_ID:-}" | tr -d '[:space:]')"
[ -n "$TOKEN" ] && [ -n "$ACCOUNT" ] || { echo "::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" >&2; exit 1; }

# "<name> <age_days>" for every dub-demo-* Worker on the account.
WORKERS="$(curl -sS --max-time 30 "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts" \
  -H "Authorization: Bearer ${TOKEN}" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s); if(!j.success){console.error(JSON.stringify(j.errors));process.exit(1)}
      for (const w of j.result) if (w.id.startsWith(process.argv[1])) {
        const age=Math.floor((Date.now()-Date.parse(w.modified_on))/86400000);
        console.log(w.id+" "+age);
      }
    })' "$PREFIX")" || { echo "::error::could not list Workers" >&2; exit 1; }

json_field() {  # json_field <file> <js expr on j>  (empty when file/field absent)
  [ -f "$1" ] || return 0
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=(new Function("j","return "+process.argv[2]))(j);if(v!=null)console.log(v)' "$1" "$2"
}

pr_state_for() {  # pr_state_for <slug> <branch>
  local pr
  pr="$(json_field deploy-state/demo-registry.json "(j.demos.find(d=>d.slug===\"$1\")||{}).pr")"
  if [ -n "$pr" ]; then gh pr view "$pr" --json state -q .state 2>/dev/null || echo NONE; return; fi
  if [ -n "$2" ]; then
    gh pr list --head "$2" --state all --json state -q '.[].state' 2>/dev/null | collapse_states; return
  fi
  echo NONE
}

DELETED=(); KEPT=(); FAILED=()
while read -r worker age; do
  [ -n "$worker" ] || continue
  slug="${worker#"$PREFIX"}"
  manifest="deploy-state/demo-${slug}.json"
  branch="$(json_field "$manifest" j.branch)"
  # refresh-demos.sh records branch=HEAD (detached scratch worktree); the registry ref is the real one.
  [ -n "$branch" ] && [ "$branch" != HEAD ] || branch="$(json_field deploy-state/demo-registry.json "(j.demos.find(d=>d.slug===\"$slug\")||{}).ref")"
  if [ -n "$ONLY_BRANCH" ] && [ "$branch" != "$ONLY_BRANCH" ]; then continue; fi

  state="$(pr_state_for "$slug" "$branch")"
  verdict="$(decide "$state" "$age" "$STALE_DAYS")"
  action="${verdict%% *}"; reason="${verdict#* }"
  line="$(printf '%-40s %-8s %s' "$worker" "$action" "$reason${branch:+ (branch $branch)}")"
  echo "$line"
  if [ "$action" = keep ]; then KEPT+=("$worker"); continue; fi
  [ "$DRY_RUN" = 1 ] && { DELETED+=("$worker"); continue; }
  if bash scripts/teardown-demo.sh "$slug" --yes >/dev/null; then DELETED+=("$worker")
  else FAILED+=("$worker"); echo "::error::failed to delete $worker" >&2; fi
done <<<"$WORKERS"

echo
echo "$([ "$DRY_RUN" = 1 ] && echo 'would delete' || echo 'deleted'): ${#DELETED[@]} · kept: ${#KEPT[@]} · failed: ${#FAILED[@]}"
[ "${#FAILED[@]}" = 0 ]
