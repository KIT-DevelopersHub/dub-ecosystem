#!/usr/bin/env bash
#
# break-glass.sh — EMERGENCY escape hatch for a production hotfix when the
# `確認した` label gate + `enforce_admins=true` branch protection would otherwise
# block an admin from merging to `main`.
#
# This does NOT weaken the gate. It is an explicit, audited, self-restoring bypass:
#   1. snapshot the current `enforce_admins` state on main
#   2. turn `enforce_admins` OFF  (admins may now merge past required checks)
#   3. admin-merge the ONE hotfix PR you name
#   4. turn `enforce_admins` back ON  (always — even if the merge fails; see trap)
# Every step is timestamped and appended to the audit log so the bypass is reviewable.
#
# All OTHER protections (required PR, required status checks for non-admins, strict)
# stay in place the whole time — only the admin-exemption is briefly lifted.
#
# Usage:
#   bash infra/deploy/break-glass.sh <PR_NUMBER> "<reason for the emergency>"
#
# Example:
#   bash infra/deploy/break-glass.sh 512 "prod gateway 500s — hotfix for null org id"
#
# Requires: gh CLI authenticated as a repo admin.
set -euo pipefail

REPO="KIT-DevelopersHub/dub-ecosystem"
BRANCH="main"
MERGE_METHOD="--squash"
LOG="infra/deploy/break-glass.log"

PR="${1:-}"
REASON="${2:-}"

die() { echo "::error::$*" >&2; exit 1; }
ts()  { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

audit() {  # audit <message> — echo to stderr AND append to the audit log
  local line="[$(ts)] [break-glass] $*"
  echo "${line}"
  echo "${line}" >> "${LOG}"
}

[ -n "${PR}" ]     || die "PR number required. Usage: break-glass.sh <PR_NUMBER> \"<reason>\""
[ -n "${REASON}" ] || die "A reason is required for the audit log. Usage: break-glass.sh <PR_NUMBER> \"<reason>\""
case "${PR}" in *[!0-9]*) die "PR must be a number, got '${PR}'." ;; esac

command -v gh >/dev/null 2>&1 || die "gh CLI not found."
ACTOR="$(gh api user --jq .login 2>/dev/null || echo 'unknown')"

# Snapshot current enforce_admins so we restore to the SAME state (normally true).
PRIOR_ENFORCE="$(gh api "repos/${REPO}/branches/${BRANCH}/protection/enforce_admins" --jq .enabled 2>/dev/null || echo 'true')"

restore() {
  # Always re-assert enforce_admins to its prior state. Idempotent.
  if [ "${PRIOR_ENFORCE}" = "false" ]; then
    audit "restore: prior enforce_admins was false — leaving OFF (nothing to re-enable)."
    return 0
  fi
  if gh api -X POST "repos/${REPO}/branches/${BRANCH}/protection/enforce_admins" >/dev/null 2>&1; then
    audit "restore: enforce_admins re-enabled (ON) on ${BRANCH}."
  else
    audit "restore: FAILED to re-enable enforce_admins — RE-RUN: gh api -X POST repos/${REPO}/branches/${BRANCH}/protection/enforce_admins"
  fi
}
trap restore EXIT

audit "OPEN by actor=${ACTOR} PR=#${PR} reason=\"${REASON}\" (prior enforce_admins=${PRIOR_ENFORCE})"

# Confirm the PR is open and targets main before we touch protection.
PR_STATE="$(gh pr view "${PR}" --repo "${REPO}" --json state,baseRefName --jq '.state + " " + .baseRefName' 2>/dev/null || echo '')"
[ "${PR_STATE}" = "OPEN ${BRANCH}" ] || die "PR #${PR} must be OPEN and target ${BRANCH} (got: '${PR_STATE}')."

# 1) enforce_admins OFF — admins may now merge past required checks.
gh api -X DELETE "repos/${REPO}/branches/${BRANCH}/protection/enforce_admins" >/dev/null
audit "enforce_admins turned OFF (admin bypass armed)."

# 2) admin-merge the hotfix PR.
if gh pr merge "${PR}" --repo "${REPO}" ${MERGE_METHOD} --admin; then
  MERGED_SHA="$(gh pr view "${PR}" --repo "${REPO}" --json mergeCommit --jq .mergeCommit.oid 2>/dev/null || echo '?')"
  audit "MERGED PR #${PR} -> ${BRANCH} (sha=${MERGED_SHA})."
else
  audit "MERGE FAILED for PR #${PR}. Protection will be restored by the exit trap."
  die "merge of PR #${PR} failed."
fi

# 3) restore runs via the EXIT trap (re-enables enforce_admins).
audit "CLOSE — restoring protection via trap."
