# shellcheck shell=bash
#
# demo-main-sync — make sure the branch a demo is built from already contains the latest
# origin/main, and merge it in when it does not.
#
# WHY: fe2-app-shell bundles every micro-frontend into one SPA. A demo built from a branch
# cut days ago ships that day's copy of every OTHER screen too, so the reviewer sees an old
# UI around the feature and approves something that will look different after merge.
#
# Sourced by deploy-demo.sh / deploy-demo-feature.sh. Call `ensure_main_merged <repo> <mode>`
#   mode=apply  fetch, and merge origin/main into HEAD if it is missing (default)
#   mode=check  fetch and report only (used by --dry-run)
# Returns 0 when HEAD contains origin/main afterwards, non-zero otherwise (nothing deployed).
# Opt out with --no-sync-main or DEMO_SKIP_MAIN_SYNC=1 (e.g. offline).

DEMO_MAIN_REF="${DEMO_MAIN_REF:-main}"

ensure_main_merged() {
  local repo="$1" mode="${2:-apply}" remote_ref="origin/${DEMO_MAIN_REF}" behind conflicts
  if ! git -C "$repo" fetch -q origin "$DEMO_MAIN_REF"; then
    echo "::error::git fetch origin ${DEMO_MAIN_REF} failed — cannot tell whether the demo has the latest main. Retry, or pass --no-sync-main to deploy as-is." >&2
    return 1
  fi
  if git -C "$repo" merge-base --is-ancestor "$remote_ref" HEAD; then
    echo "main sync: HEAD already contains ${remote_ref} ($(git -C "$repo" rev-parse --short "$remote_ref"))"
    return 0
  fi
  behind="$(git -C "$repo" rev-list --count "HEAD..${remote_ref}")"
  if [ "$mode" = check ]; then
    echo "main sync: HEAD is ${behind} commit(s) behind ${remote_ref} — a real run would merge it in first."
    return 0
  fi
  if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
    echo "::error::HEAD is ${behind} commit(s) behind ${remote_ref}, but the working tree has uncommitted changes. Commit them, then rerun (the script merges main for you)." >&2
    return 1
  fi
  echo "main sync: HEAD is ${behind} commit(s) behind ${remote_ref} — merging it in."
  if ! git -C "$repo" merge --no-edit "$remote_ref"; then
    conflicts="$(git -C "$repo" diff --name-only --diff-filter=U | sed 's/^/    /')"
    git -C "$repo" merge --abort || true
    echo "::error::merging ${remote_ref} conflicts — resolve it on the feature branch, then rerun. Nothing deployed. Conflicting files:" >&2
    echo "$conflicts" >&2
    return 1
  fi
  echo "main sync: merged ${remote_ref} -> $(git -C "$repo" rev-parse --short HEAD). Push the branch so the PR matches the demo."
}

# Offline check against throwaway repos. Prints failures; returns non-zero on any.
demo_main_sync_self_test() {
  local tmp fail=0 out
  tmp="$(mktemp -d)"
  (
    set -e
    cd "$tmp"
    git init -q --bare -b main origin.git
    git clone -q origin.git work 2>/dev/null
    cd work
    git config user.email t@t; git config user.name t
    echo base > a.txt; git add a.txt; git commit -qm base; git push -q origin main
    git checkout -qb feat; echo feat > f.txt; git add f.txt; git commit -qm feat
    git checkout -q main; echo main2 > m.txt; git add m.txt; git commit -qm main2; git push -q origin main
    git checkout -q feat
  ) >/dev/null 2>&1 || { echo "  FAIL main-sync fixture"; rm -rf "$tmp"; return 1; }
  local w="$tmp/work"

  ensure_main_merged "$w" check >/dev/null || { echo "  FAIL main-sync check mode"; fail=1; }
  git -C "$w" merge-base --is-ancestor origin/main HEAD && { echo "  FAIL main-sync check mode merged"; fail=1; }

  echo dirty >> "$w/f.txt"
  ensure_main_merged "$w" apply >/dev/null 2>&1 && { echo "  FAIL main-sync dirty tree accepted"; fail=1; }
  git -C "$w" checkout -q -- f.txt

  ensure_main_merged "$w" apply >/dev/null 2>&1 || { echo "  FAIL main-sync merge"; fail=1; }
  git -C "$w" merge-base --is-ancestor origin/main HEAD || { echo "  FAIL main-sync not merged"; fail=1; }
  out="$(ensure_main_merged "$w" apply 2>&1)" || { echo "  FAIL main-sync up-to-date"; fail=1; }
  case "$out" in *"already contains"*) : ;; *) echo "  FAIL main-sync up-to-date message"; fail=1 ;; esac

  (
    cd "$tmp"; git clone -q origin.git other 2>/dev/null; cd other
    git config user.email t@t; git config user.name t
    echo theirs > f.txt; git add f.txt; git commit -qm conflict; git push -q origin main
  ) >/dev/null 2>&1
  echo ours > "$w/f.txt"; git -C "$w" commit -qam ours
  ensure_main_merged "$w" apply >/dev/null 2>&1 && { echo "  FAIL main-sync conflict accepted"; fail=1; }
  [ -z "$(git -C "$w" status --porcelain --untracked-files=no)" ] || { echo "  FAIL main-sync conflict left tree dirty"; fail=1; }

  rm -rf "$tmp"
  return "$fail"
}
