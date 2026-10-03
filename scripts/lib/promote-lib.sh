#!/usr/bin/env bash
#
# promote-lib — shared helpers for the two promotion commands:
#   scripts/promote-staging.sh  (pnpm deploy:staging)  demo 承認版 -> staging
#   scripts/promote-prod.sh     (pnpm ship:prod)       staging 確認済み -> 本番
#
# Both promotions go through the EXISTING CI gates (staging.yml / prod-gate.yml /
# deploy.yml) — these helpers never deploy by themselves. They resolve the PR, read the
# `Liveness-Marker:` trailer, drive the label, wait for the right workflow run, and write
# the deploy-state manifest. Keeping that in one place stops the two scripts from drifting.
#
# Callers must set $ROOT (repo root) and `set -euo pipefail` before sourcing.
# Bash 3.2 compatible (macOS system bash): no associative arrays, no `${arr[@]}` on a
# possibly-empty array without a guard.

PROMOTE_SUBDOMAIN_DEFAULT="developershub-site"
# Wall-clock ceiling for waiting on a GitHub Actions run. Without it an unattended agent run
# blocks forever on a run that never leaves `queued` (Actions incident / environment approval).
PROMOTE_WAIT_MAX_MIN="${PROMOTE_WAIT_MAX_MIN:-45}"

# ---- environment origins (same source of truth as scripts/verify-live.sh) ----------
resolve_subdomain() {
  local envfile="${ROOT}/infra/deploy/staging-resources.env" sub=""
  if [ -f "$envfile" ]; then
    sub="$(awk -F= '/^STAGING_WORKERS_SUBDOMAIN=/{print $2; exit}' "$envfile" | tr -d '[:space:]')"
  fi
  printf '%s' "${sub:-$PROMOTE_SUBDOMAIN_DEFAULT}"
}

fe2_origin_for() {  # staging|prod -> the fe2 SPA origin actually served
  local env="$1" sub; sub="$(resolve_subdomain)"
  case "$env" in
    staging) printf 'https://dub-fe2-app-shell-staging.%s.workers.dev' "$sub" ;;
    prod)    printf 'https://dub-fe2-app-shell.%s.workers.dev' "$sub" ;;
    *) echo "::error::unknown env '$env' (want staging|prod)" >&2; return 2 ;;
  esac
}

# ---- gh ----------------------------------------------------------------------------
require_gh() {
  command -v gh >/dev/null 2>&1 || {
    echo "::error::gh CLI not found. Install it (brew install gh) — both promotions run through GitHub Actions." >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || {
    echo "::error::gh is not authenticated. Run: gh auth login" >&2; exit 1; }
}

# Fetch the PR as one JSON blob. `mergeable`/`mergeStateStatus` ARE used by the prod gate —
# a CONFLICTING / BLOCKED PR must never report READY.
# <ref> = PR number OR branch name. Empty output => no such PR.
pr_json() {
  local ref="$1"
  gh pr view "$ref" \
    --json number,title,url,state,body,headRefName,headRefOid,labels,isDraft,mergeable,mergeStateStatus \
    2>/dev/null || true
}

# jfield <json> <dot.path> -> scalar on stdout ("" when absent; arrays joined by ",")
jfield() {
  PROMOTE_JSON="$1" PROMOTE_PATH="$2" node -e '
    const j = JSON.parse(process.env.PROMOTE_JSON || "{}");
    let v = j;
    for (const k of process.env.PROMOTE_PATH.split(".")) v = (v == null ? v : v[k]);
    if (v == null) v = "";
    if (Array.isArray(v)) v = v.join(",");
    process.stdout.write(String(v));'
}

# has_label <json> <label> -> exit 0 when the PR carries the label
has_label() {
  PROMOTE_JSON="$1" PROMOTE_LABEL="$2" node -e '
    const j = JSON.parse(process.env.PROMOTE_JSON || "{}");
    const want = process.env.PROMOTE_LABEL;
    process.exit((j.labels || []).some((l) => l && l.name === want) ? 0 : 1);'
}

# ---- liveness markers ---------------------------------------------------------------
# The `Liveness-Marker: a, b` trailer in the PR body is what staging.yml asserts against the
# served bundle. staging.yml runs the IDENTICAL pipeline (see its "Liveness verification"
# step) — including the CR strip, because a PR body edited in the GitHub web UI is CRLF and
# a trailing \r would be grepped literally against the bundle and always miss.
marker_trailer() {  # <pr-body> -> CSV ("" when the trailer is absent)
  local body="$1"
  printf '%s\n' "$body" \
    | tr -d '\r' \
    | grep -iE '^[[:space:]]*Liveness-Marker[[:space:]]*:' \
    | head -n1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]+$//' || true
}

parse_markers() {  # CSV -> global MARKERS array (trimmed, empties dropped)
  local csv="$1"; local raw=(); local i
  MARKERS=()
  IFS=',' read -r -a raw <<< "$csv"
  for i in "${!raw[@]}"; do
    local t; t="$(printf '%s' "${raw[$i]}" | tr -d '\r' | sed 's/^ *//; s/ *$//')"
    if [ -n "$t" ]; then MARKERS[${#MARKERS[@]}]="$t"; fi
  done
}

# Normalized comparison key for a marker CSV — order/spacing-insensitive, so "a, b" and
# "b,a" are recognized as the SAME marker set (used to detect a real mismatch only).
markers_key() {  # <csv> -> normalized string
  local csv="$1"
  printf '%s' "$csv" | tr -d '\r' | tr ',' '\n' \
    | sed 's/^ *//; s/ *$//' | grep -v '^$' | LC_ALL=C sort | paste -sd'|' - || true
}

# ---- deploy-state manifest ----------------------------------------------------------
# Serialized by node, not by hand: actor/branch/note can legitimately contain quotes or
# backslashes and a hand-rolled JSON writer silently produces an invalid manifest.
write_env_manifest() {  # path env url sha branch actor live note   (uses global MARKERS)
  local path="$1"; shift
  PM_PATH="$path" PM_ENV="$1" PM_URL="$2" PM_SHA="$3" PM_BRANCH="$4" PM_ACTOR="$5" \
  PM_LIVE="$6" PM_NOTE="${7:-}" node -e '
    const fs = require("fs"), p = require("path");
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const out = {
      env: process.env.PM_ENV,
      url: process.env.PM_URL,
      deployedSha: process.env.PM_SHA,
      branch: process.env.PM_BRANCH,
      actor: process.env.PM_ACTOR,
      markers: process.argv.slice(1),
      live: process.env.PM_LIVE === "true",
      verifiedAt: now,
      updatedAt: now,
      note: process.env.PM_NOTE || "",
    };
    fs.mkdirSync(p.dirname(process.env.PM_PATH), { recursive: true });
    fs.writeFileSync(process.env.PM_PATH, JSON.stringify(out, null, 2) + "\n");
  ' ${MARKERS[@]+"${MARKERS[@]}"}
}

manifest_field() {  # <path> <field> -> value ("" when the file/field is absent)
  local path="$1" field="$2"
  [ -f "$path" ] || { printf ''; return 0; }
  PM_PATH="$path" PM_FIELD="$field" node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.env.PM_PATH, "utf8"));
      const v = j[process.env.PM_FIELD];
      process.stdout.write(v == null ? "" : String(v));
    } catch { process.stdout.write(""); }'
}

# ---- timestamps ----------------------------------------------------------------------
# GitHub returns fixed-width UTC ISO-8601 ("2026-09-22T14:08:49Z"), so a lexicographic
# comparison is a correct chronological comparison. Returns 0 when <a> is strictly newer.
iso_newer() {  # <a> <b>
  local a="$1" b="$2"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "$a" \> "$b" ]
}

# ---- GitHub Actions run waiting -----------------------------------------------------
latest_run_id() {  # <workflow-file> <head-sha>
  gh run list --workflow "$1" --commit "$2" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true
}

# Wait for a run NEWER than <previous-id> (pass "" when there is none), then poll it to
# completion under a wall-clock ceiling. Polling (rather than `gh run watch`) is what makes
# the ceiling possible and lets us surface the failing log instead of swallowing output.
# Exit: 0 success · 5 no run was ever created (trigger never fired) · 4 red or timed out.
wait_for_new_run() {  # <workflow-file> <head-sha> <previous-id> <human-label>
  local wf="$1" sha="$2" prev="$3" what="$4" id="" i=0 url="" status="" conclusion=""
  local appear_tries=40                                   # ~7 min for the run to be created
  local poll_tries=$(( PROMOTE_WAIT_MAX_MIN * 3 ))        # 20s per poll

  echo "  ${what}: waiting for a new ${wf} run on ${sha} ..."
  while [ "$i" -lt "$appear_tries" ]; do
    id="$(latest_run_id "$wf" "$sha")"
    if [ -n "$id" ] && [ "$id" != "null" ] && [ "$id" != "$prev" ]; then break; fi
    id=""; i=$((i + 1)); sleep 10
  done
  if [ -z "$id" ]; then
    echo "::error::no new ${wf} run appeared for ${sha}. The trigger never fired — check the Actions tab, the workflow's \`on:\` filters, and repo permissions." >&2
    return 5
  fi

  url="$(gh run view "$id" --json url --jq .url 2>/dev/null || echo "run id ${id}")"
  echo "  run: ${url}"
  i=0
  while [ "$i" -lt "$poll_tries" ]; do
    status="$(gh run view "$id" --json status --jq .status 2>/dev/null || echo "")"
    if [ "$status" = "completed" ]; then break; fi
    i=$((i + 1)); sleep 20
  done
  if [ "$status" != "completed" ]; then
    echo "::error::${wf} run did not finish within ${PROMOTE_WAIT_MAX_MIN} min (status=${status:-unknown}). ${url}" >&2
    echo "  (override the ceiling with PROMOTE_WAIT_MAX_MIN=<minutes>)" >&2
    return 4
  fi

  conclusion="$(gh run view "$id" --json conclusion --jq .conclusion 2>/dev/null || echo "")"
  if [ "$conclusion" = "success" ]; then return 0; fi
  echo "::error::${wf} run concluded '${conclusion}'. ${url}" >&2
  gh run view "$id" --log-failed 2>/dev/null | tail -40 >&2 || true
  return 4
}
