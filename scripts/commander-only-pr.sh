#!/usr/bin/env bash
# commander-only-pr — exit 0 iff a PR touches ONLY Commander app code.
#
# Commander (the owner's local dev cockpit) ships straight to production: no demo, no
# staging, no 「確認した」 label. Every other app keeps the demo -> staging -> 確認した gate.
# This is the single definition of "Commander-only", shared by prod-gate.yml, deploy.yml
# and the Commander agent's PreToolUse guard (commander/.claude-home/hooks/).
#
# Deliberately NOT exempt (still need 「確認した」):
#   commander/.claude-home/   the agent's own rules/hooks/settings — the guard must not be
#                             loosenable by the guarded agent itself
#   infra/d1/migrations/      shared prod D1, even the commander_ namespace
#   scripts/, .github/        this gate itself
#
# Usage: scripts/commander-only-pr.sh <PR number> [--repo owner/name]
# Fail-close: any API error => exit 1 (= not exempt).
set -euo pipefail

PR="${1:-}"
REPO="${GITHUB_REPOSITORY:-KIT-DevelopersHub/dub-ecosystem}"
if [ "${2:-}" = "--repo" ] && [ -n "${3:-}" ]; then REPO="$3"; fi
[ -n "${PR}" ] || { echo "usage: $0 <PR number> [--repo owner/name]" >&2; exit 2; }

# filename + previous_filename so moving a file OUT of commander/ is not exempt.
FILES="$(gh api --paginate "repos/${REPO}/pulls/${PR}/files" \
  --jq '.[] | .filename, (.previous_filename // empty)')" || exit 1
[ -n "${FILES}" ] || exit 1

while IFS= read -r f; do
  case "${f}" in
    commander/.claude-home/*) echo "not commander-only: ${f}"; exit 1 ;;
    commander/* | services/commander-service/* | packages/commander-phases/* | \
      apps/fe2-app-shell/src/features/commander/*) ;;
    *) echo "not commander-only: ${f}"; exit 1 ;;
  esac
done <<< "${FILES}"

echo "commander-only: PR #${PR}"
