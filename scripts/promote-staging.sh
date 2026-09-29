#!/usr/bin/env bash
#
# promote-staging — ONE command for "demo で承認された版を staging に反映する".
#
# WHY this exists:
#   staging は PR に `stagingへ` ラベルを付けると staging.yml が CI でデプロイする、という
#   経路しか無い。つまり反映には「PR を開く → ラベルを付ける → CI を待つ → verify:live で
#   実測する → deploy-state を更新する → URL を渡す」の 5〜6 手が必要で、全部人手だった。
#   手順書 (runbook 04/06) には書いてあるが実行コマンドが無いので、毎回どこかが抜ける
#   (ラベルだけ付けて CI を見ない / 反映前の URL を確認に出す / 台帳が古いまま)。
#   このスクリプトはその一連を 1 コマンドにまとめ、**verify:live が PASS した時だけ**
#   staging URL を出力する。反映が確認できないものは確認依頼に出せない。
#
# WHAT IT DOES NOT DO (意図的):
#   * 自前で wrangler deploy しない。デプロイ経路は staging.yml (CI) 1 本のまま
#     — ローカルから第二の経路を生やすと「何が staging に載っているか」が二重管理になる。
#   * 本番には一切触れない。本番へ進めるのは scripts/promote-prod.sh (許可ゲート付き)。
#   * `確認した` ラベルは絶対に付けない (自己承認の禁止)。
#
# Usage:
#   scripts/promote-staging.sh [--pr <n> | --branch <b>] [--markers "<m1>[,<m2>...]"]
#   scripts/promote-staging.sh --dry-run          # 何もせず計画だけ出す
#   scripts/promote-staging.sh --no-wait          # ラベルを付けるまで (CI 完了を待たない)
#   scripts/promote-staging.sh --self-test        # オフライン検証 (network/gh 不要)
#
#   --pr       対象 PR 番号。省略時は --branch、それも省略時は現在のブランチから解決。
#   --branch   対象ブランチ (その head の PR を使う)。
#   --markers  この機能固有のマーカー CSV。省略時は PR 本文の `Liveness-Marker:` 行を使う。
#              両方無ければ中断 (マーカー無し = 反映を機械検証できない)。
#              PR 本文に trailer が無ければ本文末尾に追記し、**食い違っていれば中断**する
#              (CI が検証する文字列とローカルの実測対象は常に同一でなければならない)。
#   --note     deploy-state/staging.json に残す備考。
#
# Exit codes: 0 ok (LIVE) · 2 usage/不整合 · 1 前提不足 (gh/PR 無し等) · 3 not-live ·
#             4 CI が赤/時間切れ · 5 CI run が作られなかった (トリガー未発火)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/promote-lib.sh
. "${ROOT}/scripts/lib/promote-lib.sh"

STAGING_LABEL="stagingへ"
MANIFEST="deploy-state/staging.json"
WORKFLOW="staging.yml"

PROMOTE_TMP=""
cleanup() { [ -n "$PROMOTE_TMP" ] && rm -rf "$PROMOTE_TMP"; return 0; }
trap cleanup EXIT

# ---- self-test (offline; no gh / no network) ---------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fail=0
  MARKERS=()
  [ "$(marker_trailer 'x
Liveness-Marker: a, b ,c
y')" = "a, b ,c" ] || { echo "  FAIL marker_trailer extract"; fail=1; }
  [ -z "$(marker_trailer 'no trailer here')" ] || { echo "  FAIL marker_trailer absent"; fail=1; }
  [ "$(marker_trailer 'liveness-marker:  zz')" = "zz" ] || { echo "  FAIL marker_trailer case"; fail=1; }
  # CRLF (GitHub web UI で編集された本文) で \r が残らないこと — staging.yml と同じ結果になる
  [ "$(marker_trailer "$(printf 'Liveness-Marker: foo\r\nnext\r\n')")" = "foo" ] \
    || { echo "  FAIL marker_trailer CRLF"; fail=1; }
  parse_markers 'a, b ,c'
  [ "${#MARKERS[@]}" = 3 ] && [ "${MARKERS[1]}" = "b" ] || { echo "  FAIL parse_markers"; fail=1; }
  parse_markers "$(printf 'a,b\r')"
  [ "${MARKERS[1]}" = "b" ] || { echo "  FAIL parse_markers CRLF"; fail=1; }
  # 同じ集合は順序/空白が違っても同一とみなす (誤検知で中断しないため)
  [ "$(markers_key 'a, b')" = "$(markers_key 'b,a')" ] || { echo "  FAIL markers_key order"; fail=1; }
  [ "$(markers_key 'a,b')" != "$(markers_key 'a,c')" ] || { echo "  FAIL markers_key differ"; fail=1; }
  case "$(fe2_origin_for staging)" in https://dub-fe2-app-shell-staging.*.workers.dev) : ;;
    *) echo "  FAIL staging origin"; fail=1 ;; esac
  PRJ='{"number":7,"state":"OPEN","isDraft":false,"headRefOid":"abc","labels":[{"name":"stagingへ"}]}'
  [ "$(jfield "$PRJ" number)" = 7 ] || { echo "  FAIL jfield"; fail=1; }
  [ "$(jfield "$PRJ" nope.deep)" = "" ] || { echo "  FAIL jfield missing"; fail=1; }
  has_label "$PRJ" 'stagingへ' || { echo "  FAIL has_label present"; fail=1; }
  if has_label "$PRJ" '確認した'; then echo "  FAIL has_label absent"; fail=1; fi
  PROMOTE_TMP="$(mktemp -d)"
  parse_markers 'data-testid="x", 一括削除'
  # actor/note に " や \ が入っても壊れない JSON を書けること
  write_env_manifest "$PROMOTE_TMP/s.json" staging https://x abc br 'me "the\dev"' true 'n "q"'
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ok = j.env === "staging" && j.live === true && j.markers.length === 2
      && j.markers[0] === "data-testid=\"x\"" && j.markers[1] === "一括削除"
      && j.actor === "me \"the\\dev\"";
    process.exit(ok ? 0 : 1);' "$PROMOTE_TMP/s.json" || { echo "  FAIL manifest write/escaping"; fail=1; }
  [ "$(manifest_field "$PROMOTE_TMP/s.json" deployedSha)" = abc ] || { echo "  FAIL manifest_field"; fail=1; }
  [ "$(manifest_field "$PROMOTE_TMP/nope.json" deployedSha)" = "" ] || { echo "  FAIL manifest_field missing"; fail=1; }
  if [ "$fail" = 0 ]; then echo "promote-staging self-test: PASS"; exit 0
  else echo "promote-staging self-test: FAIL"; exit 1; fi
fi

# ---- args ---------------------------------------------------------------------------
PR_REF=""; BRANCH_ARG=""; MARKERS_CSV=""; NOTE=""; DRY_RUN=0; WAIT=1
declare -a MARKERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)      PR_REF="${2:?}"; shift 2 ;;
    --branch)  BRANCH_ARG="${2:?}"; shift 2 ;;
    --markers) MARKERS_CSV="${2:?}"; shift 2 ;;
    --note)    NOTE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-wait) WAIT=0; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cd "$ROOT"
require_gh

# ---- resolve the PR ------------------------------------------------------------------
REF="$PR_REF"
if [ -z "$REF" ]; then REF="${BRANCH_ARG:-$(git rev-parse --abbrev-ref HEAD)}"; fi
PRJ="$(pr_json "$REF")"
if [ -z "$PRJ" ]; then
  echo "::error::'${REF}' に対応する PR がありません。staging 反映は PR + \`${STAGING_LABEL}\` ラベル経由のみです。" >&2
  echo "  先に PR を作ってください (本文1行目の「通知文言」はユーザー向けの一言 — CLAUDE.md 参照):" >&2
  echo "    gh pr create --fill --base main" >&2
  exit 1
fi

PR_NUM="$(jfield "$PRJ" number)"
PR_URL="$(jfield "$PRJ" url)"
PR_STATE="$(jfield "$PRJ" state)"
PR_BODY="$(jfield "$PRJ" body)"
HEAD_REF="$(jfield "$PRJ" headRefName)"
HEAD_SHA="$(jfield "$PRJ" headRefOid)"
ACTOR="$(git config user.name 2>/dev/null || echo "${USER:-unknown}")"
URL="$(fe2_origin_for staging)"

if [ "$PR_STATE" != "OPEN" ]; then
  echo "::error::PR #${PR_NUM} は ${PR_STATE} です。staging 反映は open な PR にだけ行えます。" >&2
  exit 1
fi

# ---- markers: PR 本文の trailer が CI の検証対象。ローカルと必ず同一にする ---------------
BODY_MARKERS="$(marker_trailer "$PR_BODY")"
if [ -z "$MARKERS_CSV" ]; then
  MARKERS_CSV="$BODY_MARKERS"
elif [ -n "$BODY_MARKERS" ] && [ "$(markers_key "$MARKERS_CSV")" != "$(markers_key "$BODY_MARKERS")" ]; then
  # CI は本文の trailer を、ローカル verify:live と manifest は --markers を見るため、
  # 食い違ったまま進むと「CI 緑・証跡は別物」になる。単一の真実源を選ばせる。
  echo "::error::--markers と PR 本文の 'Liveness-Marker:' が食い違っています。CI は本文を検証するので、両者は同一でなければなりません。" >&2
  echo "  --markers    : ${MARKERS_CSV}" >&2
  echo "  PR 本文      : ${BODY_MARKERS}" >&2
  echo "  どちらかに揃えてください (本文を直すか、--markers を省いて本文の値を使う)。" >&2
  exit 2
fi
if [ -z "$MARKERS_CSV" ]; then
  echo "::error::マーカーがありません。--markers \"<機能固有の文字列>\" を渡すか、PR 本文に 'Liveness-Marker: <文字列>' を書いてください。" >&2
  echo "  マーカー無しでは配信バンドルに機能が実在するかを機械検証できず、確認依頼を出せません。" >&2
  exit 2
fi
parse_markers "$MARKERS_CSV"

echo "staging 反映プラン:"
echo "  PR       : #${PR_NUM} (${HEAD_REF} @ ${HEAD_SHA})"
echo "  URL      : ${PR_URL}"
echo "  label    : ${STAGING_LABEL}"
echo "  markers  : ${MARKERS[*]}"
echo "  target   : staging (fe2)"
echo "  manifest : ${MANIFEST}"
# staging URL は実測 PASS の分岐でだけ出す。ここで出すと「反映前の URL を確認に出す」が再現する。

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  echo "[dry-run] would ensure the 'Liveness-Marker:' trailer is in the PR body"
  echo "[dry-run] would (re)apply the '${STAGING_LABEL}' label -> staging.yml deploys"
  echo "[dry-run] would wait for the ${WORKFLOW} run on ${HEAD_SHA}"
  echo "[dry-run] would verify: scripts/verify-live.sh staging ${MARKERS[*]}"
  echo "[dry-run] would write ${MANIFEST}. Nothing changed."
  exit 0
fi

# ---- 1) PR 本文に Liveness-Marker trailer を保証 (staging.yml の liveness ゲートが読む) --
if [ -z "$BODY_MARKERS" ]; then
  PROMOTE_TMP="$(mktemp -d)"
  printf '%s\n\nLiveness-Marker: %s\n' "$PR_BODY" "$MARKERS_CSV" > "${PROMOTE_TMP}/body.md"
  gh pr edit "$PR_NUM" --body-file "${PROMOTE_TMP}/body.md" >/dev/null
  echo "  + PR 本文に 'Liveness-Marker: ${MARKERS_CSV}' を追記しました (CI の liveness ゲート用)"
fi

# ---- 2) ラベルを (再)適用して staging.yml を発火 ----------------------------------------
PREV_RUN="$(latest_run_id "$WORKFLOW" "$HEAD_SHA")"
REMOVED=0
if has_label "$PRJ" "$STAGING_LABEL"; then
  # `labeled` イベントは「付いた瞬間」しか発火しないので、付いたままなら一度外して付け直す。
  gh pr edit "$PR_NUM" --remove-label "$STAGING_LABEL" >/dev/null
  REMOVED=1
  echo "  - '${STAGING_LABEL}' を一旦外しました (再デプロイを発火させるため)"
fi
if ! gh pr edit "$PR_NUM" --add-label "$STAGING_LABEL" >/dev/null; then
  if [ "$REMOVED" = 1 ]; then
    echo "::error::'${STAGING_LABEL}' を外した後の再付与に失敗しました。PR #${PR_NUM} はラベルが外れたままです。手で付け直してください: gh pr edit ${PR_NUM} --add-label '${STAGING_LABEL}'" >&2
  else
    echo "::error::'${STAGING_LABEL}' の付与に失敗しました (権限/ネットワーク)。" >&2
  fi
  exit 1
fi
echo "  + '${STAGING_LABEL}' を付与 -> ${WORKFLOW} が staging にデプロイします"

if [ "$WAIT" = 0 ]; then
  echo ""
  echo "[--no-wait] CI の完了を待っていません。反映は未確認なので、まだ URL を確認依頼に出さないでください。"
  echo "  gh run watch \$(gh run list --workflow ${WORKFLOW} --commit ${HEAD_SHA} --limit 1 --json databaseId --jq '.[0].databaseId')"
  echo "  pnpm verify:live staging ${MARKERS[*]}"
  exit 0
fi

# ---- 3) CI (build + deploy + CI 側 liveness) の完了を待つ --------------------------------
rc=0
wait_for_new_run "$WORKFLOW" "$HEAD_SHA" "$PREV_RUN" "staging deploy" || rc=$?
if [ "$rc" != 0 ]; then
  echo "::error::staging へ反映できませんでした (${WORKFLOW})。staging は更新されていません。" >&2
  exit "$rc"
fi
echo "  ✓ ${WORKFLOW} 完了"

# ---- 4) 配信物に対する実測 (これが確認依頼に添える証跡) ----------------------------------
echo "::group::post-deploy liveness (served ${URL})"
if bash scripts/verify-live.sh staging ${MARKERS[@]+"${MARKERS[@]}"}; then live=true; else live=false; fi
echo "::endgroup::"

write_env_manifest "$MANIFEST" staging "$URL" "$HEAD_SHA" "$HEAD_REF" "$ACTOR" "$live" \
  "${NOTE:-PR #${PR_NUM} promoted to staging via promote-staging.sh}"
echo "manifest written: ${MANIFEST} (live=${live})"

if [ "$live" != true ]; then
  echo "::error::staging に機能が載っていません (マーカー欠落)。確認依頼を出さないでください。" >&2
  exit 3
fi

echo ""
echo "staging LIVE ✅  ${URL}  (PR #${PR_NUM}, sha ${HEAD_SHA})"
echo "台帳を記録: git add ${MANIFEST} && git commit -m 'chore(deploy-state): staging = PR #${PR_NUM}'"
echo "次: オーナーがこの URL で確認 -> 「確認した」ラベルを付与 -> pnpm ship:prod --pr ${PR_NUM}"
echo "(「確認した」はオーナーだけが付けます。エージェントの自己承認は禁止。)"
