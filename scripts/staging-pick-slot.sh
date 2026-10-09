#!/usr/bin/env bash
#
# staging-pick-slot — choose the free staging slot for a PR (used by Commander's staging run).
#
#   slot 2  `staging2へ`  PR-only (main merges never overwrite it)   <- preferred
#   slot 1  `stagingへ`   also redeployed from main on every merge
#
# A slot is busy while ANY open PR carries its label. If --pr <n> already holds a slot, that
# slot is returned (re-deploying the same PR is not a conflict).
#
# Usage:
#   scripts/staging-pick-slot.sh [--pr <n>]     # prints slot=, label=, verify_env=, fe2=
#   scripts/staging-pick-slot.sh --self-test
#
# Exit codes: 0 picked · 10 both slots busy (occupants printed) · 2 usage.
set -euo pipefail

REPO="${REPO:-KIT-DevelopersHub/dub-ecosystem}"
SUB="developershub-site"

holders() {  # <label> -> open PR numbers carrying it (space separated)
  gh pr list --repo "$REPO" --state open --label "$1" --json number --jq '[.[].number] | join(" ")'
}

emit() {  # <slot>
  local label env sfx
  if [ "$1" = 2 ]; then label="staging2へ"; env="staging2"; sfx="-staging2"
  else label="stagingへ"; env="staging"; sfx="-staging"; fi
  echo "slot=$1"
  echo "label=${label}"
  echo "verify_env=${env}"
  echo "fe2=https://dub-fe2-app-shell${sfx}.${SUB}.workers.dev"
}

# pick <pr> <slot1 holders> <slot2 holders> -> slot number, or "busy"
pick() {
  local pr="$1" h1=" $2 " h2=" $3 "
  if [ -n "$pr" ] && [[ "$h2" == *" $pr "* ]]; then echo 2; return; fi
  if [ -n "$pr" ] && [[ "$h1" == *" $pr "* ]]; then echo 1; return; fi
  if [ -z "${3// /}" ]; then echo 2; return; fi
  if [ -z "${2// /}" ]; then echo 1; return; fi
  echo busy
}

self_test() {
  local fail=0
  t() { local got; got="$(pick "$1" "$2" "$3")"
    if [ "$got" = "$4" ]; then echo "  ok  pr=$1 s1=[$2] s2=[$3] -> $got"
    else echo "  FAIL pr=$1 s1=[$2] s2=[$3] -> $got (want $4)"; fail=1; fi; }
  t ""  ""    ""    2
  t ""  "579" ""    2
  t ""  ""    "600" 1
  t ""  "579" "600" busy
  t 600 "579" "600" 2
  t 579 "579" "600" 1
  t 601 "579" "600" busy
  t 60  "579" "600" busy
  [ "$fail" = 0 ] && echo "self-test: PASS" || { echo "self-test: FAIL"; exit 1; }
}

PR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="${2:-}"; shift 2 ;;
    --self-test) self_test; exit 0 ;;
    *) echo "usage: $0 [--pr <n>] | --self-test" >&2; exit 2 ;;
  esac
done

H1="$(holders "stagingへ")"
H2="$(holders "staging2へ")"
SLOT="$(pick "$PR" "$H1" "$H2")"
if [ "$SLOT" = busy ]; then
  echo "both staging slots are busy: stagingへ=#${H1// /,#} staging2へ=#${H2// /,#}" >&2
  exit 10
fi
emit "$SLOT"
