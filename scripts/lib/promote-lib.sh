#!/usr/bin/env bash
#
# promote-lib — the pure, shared logic behind the "is this build actually the one on the
# environment?" guards. Sourced by scripts/promote-prod.sh AND by the inline `run:` steps of
# .github/workflows/{staging,deploy}.yml so the three can never drift apart.
#
# WHY this file exists (the 2026-09-29 incident, in order):
#
#   1. The owner reviewed PR #562 (ロール管理リファクタ) on staging at 15:01:21Z.
#   2. At 15:14:56Z an UNRELATED PR (#561) merged to `main`. staging.yml also fires on
#      `push: main` and redeploys the SINGLE shared staging slot from main's HEAD — so #562
#      was silently evicted from staging 13m35s later. Nothing told anyone; the staging URL
#      simply started serving a different build under the same address.
#   3. #562 was never merged, so production still serves the OLD role UI (#270/#526).
#   4. `deploy-state/prod.json` was still the seed (`deployedSha: null`) and deploy.yml never
#      ran verify-live after deploying — so a stale production is undetectable by machine.
#   5. The strongest promotion guard we had ("the SHA on staging == the PR head SHA") read
#      `deploy-state/staging.json`, which NO workflow ever writes. It printed
#      "deployedSha がありません" every single time and was therefore inert.
#   6. #562's `Liveness-Marker:` trailer was `アプリのアクセス権` — a string that ALSO exists
#      on main (apps/fe7-admin-roster/src/components/AppAccessSection.tsx). A marker that is
#      already on the base proves nothing: it passes against a completely unchanged bundle.
#
# Everything here is PURE and offline-testable (`scripts/lib/promote-lib.sh --self-test`,
# wired into `pnpm scripts:selftest`). Network access is confined to two seams that the
# self-test overrides with fixtures:
#   PROMOTE_GH_RUNS_JSON  — file holding a canned `gh run list ... --json ...` payload
#   PROMOTE_STAGING_MANIFEST — path to the deploy-state/staging.json to read
#
# NOTE: no `set -euo pipefail` at file scope — this file is SOURCED into workflow steps and
# must not silently change the caller's shell options (`-u` in particular breaks the
# `${VAR}` defaulting those steps rely on). The self-test block sets its own options.

# ---------------------------------------------------------------------------------------
# parse_liveness_markers — stdin: a PR body. stdout: one normalised marker per line.
#
# THE normalisation, in one place. staging.yml (liveness gate), deploy.yml (prod liveness)
# and promote-prod.sh all call THIS function, because three hand-rolled copies of
# "grep the trailer, split on commas, trim" is exactly how a marker passes in one place and
# fails in another. Rules, in order:
#   * `tr -d '\r'`               — PR bodies come back from the GitHub API with CRLF; a
#                                  trailing \r turns `marker` into `marker\r` and every
#                                  grep -F against the bundle then misses.
#   * first `Liveness-Marker:` line only, case-insensitive, leading whitespace tolerated.
#   * everything after the first colon is the payload; comma-separated.
#   * each field trimmed of leading/trailing whitespace; empty fields dropped.
# Emits nothing (exit 0) when there is no trailer — "no trailer" is a legitimate,
# back-compatible state (docs/chore PRs), NOT an error.
# ---------------------------------------------------------------------------------------
parse_liveness_markers() {
  tr -d '\r' \
    | grep -iE '^[[:space:]]*Liveness-Marker[[:space:]]*:' \
    | head -n1 \
    | sed -E 's/^[^:]*:[[:space:]]*//' \
    | tr ',' '\n' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -v '^[[:space:]]*$' \
    || true
}

# ---------------------------------------------------------------------------------------
# markers_base_unique <base-ref> <marker> [<marker> ...]
#
# Guard G3. A Liveness-Marker only proves anything if it CANNOT already be found on the base
# the branch was cut from: a marker that exists on main passes against a bundle built from
# main, which is precisely the "staging was silently re-deployed from main" case above
# (#562's `アプリのアクセス権` would have gone green on a bundle with none of #562 in it).
#
# Requires AT LEAST ONE marker that does not exist in <base-ref>'s tree.
# Per-marker verdicts go to stderr (so callers can pipe stdout freely).
#
# Exit: 0 = at least one branch-unique marker · 1 = every marker already exists on the base
#       2 = <base-ref> is not resolvable / git errored — UNKNOWN, callers must warn and skip
#           rather than fail (a shallow CI checkout must not turn into a red check).
# ---------------------------------------------------------------------------------------
markers_base_unique() {
  local base="${1:-}"; shift || true
  [ -n "$base" ] || return 2
  [ "$#" -gt 0 ] || return 2
  git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1 || return 2

  local m rc unique=0
  for m in "$@"; do
    rc=0
    # -e so a marker starting with `-` is never parsed as an option; -I skips binaries.
    git grep -I -F -q -e "$m" "$base" -- >/dev/null 2>&1 || rc=$?
    case "$rc" in
      0) printf '  = already on base   %s\n' "$m" >&2 ;;
      1) printf '  + branch-unique     %s\n' "$m" >&2; unique=1 ;;
      *) printf '  ? git grep failed (rc=%s) for %s\n' "$rc" "$m" >&2; return 2 ;;
    esac
  done
  [ "$unique" = 1 ]
}

# ---------------------------------------------------------------------------------------
# staging_manifest_sha [<manifest-path>] — stdout: the recorded deployedSha, or nothing.
# Returns 1 when the manifest is absent/unparseable/still the seed (`deployedSha: null`).
# ---------------------------------------------------------------------------------------
staging_manifest_sha() {
  local f="${1:-${PROMOTE_STAGING_MANIFEST:-deploy-state/staging.json}}"
  [ -f "$f" ] || return 1
  local sha
  sha="$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const s = j && j.deployedSha;
      if (typeof s === "string" && s.trim()) process.stdout.write(s.trim());
    } catch { /* unparseable manifest == no answer */ }
  ' "$f" 2>/dev/null)" || return 1
  [ -n "$sha" ] || return 1
  printf '%s' "$sha"
}

# ---------------------------------------------------------------------------------------
# ci_staging_run [<repo>] — stdout: "<headSha>\t<headBranch>\t<createdAt>\t<event>" for the
# most recent SUCCESSFUL staging.yml run. Returns 1 when there is no such run.
#
# This is the FALLBACK that makes the occupancy guard real. `deploy-state/staging.json` has
# never been written by any workflow, so the manifest branch of the guard has always come up
# empty and the guard has always been a no-op. GitHub, however, does know: the newest green
# staging.yml run IS what the single shared staging slot last served.
# ---------------------------------------------------------------------------------------
ci_staging_run() {
  local repo="${1:-${GITHUB_REPOSITORY:-}}" json=""
  if [ -n "${PROMOTE_GH_RUNS_JSON:-}" ]; then
    json="$(cat "$PROMOTE_GH_RUNS_JSON" 2>/dev/null || echo '[]')"
  else
    json="$(gh run list ${repo:+--repo "$repo"} --workflow=staging.yml --limit 40 \
      --json headBranch,headSha,status,conclusion,createdAt,event 2>/dev/null || echo '[]')"
  fi
  printf '%s' "$json" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let rows = [];
      try { rows = JSON.parse(s || "[]"); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      const ok = rows.filter(r => r && r.status === "completed" && r.conclusion === "success");
      ok.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const r = ok[0];
      if (!r || !r.headSha) process.exit(1);
      console.log([r.headSha, r.headBranch || "", r.createdAt || "", r.event || ""].join("\t"));
    });
  '
}

# ---------------------------------------------------------------------------------------
# resolve_staging_occupant [<repo>] — who is on the single shared staging slot RIGHT NOW?
#
# Sets: STAGING_OCCUPANT_SOURCE (manifest|ci-run|unknown) · STAGING_OCCUPANT_SHA
#       STAGING_OCCUPANT_BRANCH · STAGING_OCCUPANT_AT · STAGING_OCCUPANT_DETAIL
# Returns 0 when a SHA was resolved, 1 when nothing could be determined.
#
# The SOURCE is reported on purpose: "manifest says X" and "the newest green CI run says X"
# are different strengths of evidence, and a guard that hides which one it used is how the
# inert "deployedSha がありません" path went unnoticed for so long.
# ---------------------------------------------------------------------------------------
resolve_staging_occupant() {
  local repo="${1:-${GITHUB_REPOSITORY:-}}"
  STAGING_OCCUPANT_SOURCE="unknown"
  STAGING_OCCUPANT_SHA=""
  STAGING_OCCUPANT_BRANCH=""
  STAGING_OCCUPANT_AT=""
  STAGING_OCCUPANT_DETAIL=""

  local sha=""
  if sha="$(staging_manifest_sha)"; then
    STAGING_OCCUPANT_SOURCE="manifest"
    STAGING_OCCUPANT_SHA="$sha"
    STAGING_OCCUPANT_DETAIL="deploy-state/staging.json (deployedSha)"
    return 0
  fi

  local line
  if line="$(ci_staging_run "$repo")" && [ -n "$line" ]; then
    STAGING_OCCUPANT_SOURCE="ci-run"
    STAGING_OCCUPANT_SHA="$(printf '%s' "$line" | cut -f1)"
    STAGING_OCCUPANT_BRANCH="$(printf '%s' "$line" | cut -f2)"
    STAGING_OCCUPANT_AT="$(printf '%s' "$line" | cut -f3)"
    STAGING_OCCUPANT_DETAIL="newest successful staging.yml run ($(printf '%s' "$line" | cut -f4) @ ${STAGING_OCCUPANT_AT})"
    return 0
  fi

  STAGING_OCCUPANT_DETAIL="manifest is still the seed (deployedSha: null) and no successful staging.yml run could be read"
  return 1
}

# =========================================================================================
# self-test (offline) — only when this file is EXECUTED, never when it is sourced.
# =========================================================================================
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -eo pipefail
  fail=0
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

  check() {  # <label> <expected> <actual>
    if [ "$2" = "$3" ]; then printf '  ok  %s\n' "$1"
    else printf '  FAIL %s — expected [%s] got [%s]\n' "$1" "$2" "$3"; fail=1; fi
  }

  # --- parse_liveness_markers -----------------------------------------------------------
  check "marker: single" \
    'data-testid="role-matrix"' \
    "$(printf 'blah\nLiveness-Marker: data-testid="role-matrix"\nmore\n' | parse_liveness_markers)"

  check "marker: CRLF body is stripped" \
    'abc' \
    "$(printf 'x\r\nLiveness-Marker: abc\r\ny\r\n' | parse_liveness_markers)"

  check "marker: comma list is split + trimmed" \
    "$(printf 'one\ntwo\nthree')" \
    "$(printf 'Liveness-Marker:   one ,two,  three  \n' | parse_liveness_markers)"

  check "marker: case-insensitive + leading space" \
    'zz' \
    "$(printf '   liveness-marker :zz\n' | parse_liveness_markers)"

  check "marker: no trailer -> empty" \
    '' \
    "$(printf 'just a normal PR body\nwith no trailer\n' | parse_liveness_markers)"

  check "marker: only the FIRST trailer wins" \
    'first' \
    "$(printf 'Liveness-Marker: first\nLiveness-Marker: second\n' | parse_liveness_markers)"

  # --- markers_base_unique --------------------------------------------------------------
  # Build a throwaway repo: base has ON_BASE_ONLY, the branch adds BRANCH_NEW_MARKER.
  # This reproduces the #562 shape exactly (a marker that exists on the base).
  (
    cd "$tmp"
    git init -q repo
    cd repo
    git config user.email t@example.com
    git config user.name  t
    printf 'ON_BASE_ONLY is here\n' > base.txt
    git add base.txt
    git commit -qm base
    git branch -q basebranch
    printf 'BRANCH_NEW_MARKER is here\n' > feat.txt
    git add feat.txt
    git commit -qm feat
  ) >/dev/null 2>&1

  (
    cd "$tmp/repo"
    rc=0; markers_base_unique basebranch 'ON_BASE_ONLY' >/dev/null 2>&1 || rc=$?
    [ "$rc" = 1 ] || { echo "  FAIL base-only marker should be rejected (rc=$rc)"; exit 1; }
    echo "  ok  base-only marker rejected (rc=1)"

    rc=0; markers_base_unique basebranch 'ON_BASE_ONLY' 'BRANCH_NEW_MARKER' >/dev/null 2>&1 || rc=$?
    [ "$rc" = 0 ] || { echo "  FAIL mixed set should pass on the unique one (rc=$rc)"; exit 1; }
    echo "  ok  mixed set accepted via the branch-unique marker (rc=0)"

    rc=0; markers_base_unique basebranch 'BRANCH_NEW_MARKER' >/dev/null 2>&1 || rc=$?
    [ "$rc" = 0 ] || { echo "  FAIL branch-unique marker should pass (rc=$rc)"; exit 1; }
    echo "  ok  branch-unique marker accepted (rc=0)"

    rc=0; markers_base_unique no-such-ref 'ANY' >/dev/null 2>&1 || rc=$?
    [ "$rc" = 2 ] || { echo "  FAIL unresolvable base should be UNKNOWN=2 (rc=$rc)"; exit 1; }
    echo "  ok  unresolvable base -> UNKNOWN (rc=2, caller warns + skips)"

    rc=0; markers_base_unique basebranch >/dev/null 2>&1 || rc=$?
    [ "$rc" = 2 ] || { echo "  FAIL no markers should be UNKNOWN=2 (rc=$rc)"; exit 1; }
    echo "  ok  no markers -> UNKNOWN (rc=2)"
  ) || fail=1

  # --- staging occupancy: manifest path -------------------------------------------------
  printf '{"env":"staging","deployedSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n' > "$tmp/populated.json"
  export PROMOTE_STAGING_MANIFEST="$tmp/populated.json"
  resolve_staging_occupant >/dev/null 2>&1 || true
  check "occupancy: populated manifest wins"  "manifest" "$STAGING_OCCUPANT_SOURCE"
  check "occupancy: manifest sha is reported" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$STAGING_OCCUPANT_SHA"

  # --- staging occupancy: CI-run fallback (the seed manifest, i.e. reality today) --------
  printf '{"env":"staging","deployedSha":null}\n' > "$tmp/seed.json"
  cat > "$tmp/runs.json" <<'JSON'
[
  {"headBranch":"feat/old","headSha":"1111111111111111111111111111111111111111","status":"completed","conclusion":"success","createdAt":"2026-09-29T10:00:00Z","event":"pull_request"},
  {"headBranch":"main","headSha":"2222222222222222222222222222222222222222","status":"completed","conclusion":"success","createdAt":"2026-09-29T15:14:56Z","event":"push"},
  {"headBranch":"feat/fe7-role-policy-demo","headSha":"3333333333333333333333333333333333333333","status":"completed","conclusion":"failure","createdAt":"2026-09-29T16:00:00Z","event":"pull_request"},
  {"headBranch":"feat/newer","headSha":"4444444444444444444444444444444444444444","status":"in_progress","conclusion":null,"createdAt":"2026-09-29T17:00:00Z","event":"pull_request"}
]
JSON
  export PROMOTE_STAGING_MANIFEST="$tmp/seed.json"
  export PROMOTE_GH_RUNS_JSON="$tmp/runs.json"
  resolve_staging_occupant >/dev/null 2>&1 || true
  check "occupancy: seed manifest falls back to CI"  "ci-run" "$STAGING_OCCUPANT_SOURCE"
  # newest SUCCESSFUL run — not the newer failed one, not the in-progress one. This is the
  # push:main deploy that evicted #562.
  check "occupancy: newest SUCCESSFUL run wins"      "2222222222222222222222222222222222222222" "$STAGING_OCCUPANT_SHA"
  check "occupancy: branch reported"                 "main" "$STAGING_OCCUPANT_BRANCH"

  # --- staging occupancy: nothing knowable ----------------------------------------------
  printf '[]\n' > "$tmp/empty.json"
  export PROMOTE_GH_RUNS_JSON="$tmp/empty.json"
  rc=0; resolve_staging_occupant >/dev/null 2>&1 || rc=$?
  check "occupancy: no evidence -> rc=1"       "1" "$rc"
  check "occupancy: no evidence -> unknown"    "unknown" "$STAGING_OCCUPANT_SOURCE"

  if [ "$fail" = 0 ]; then echo "promote-lib self-test: PASS"; exit 0
  else echo "promote-lib self-test: FAIL"; exit 1; fi
fi
