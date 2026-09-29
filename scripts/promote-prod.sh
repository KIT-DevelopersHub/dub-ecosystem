#!/usr/bin/env bash
#
# promote-prod — staging で確認済みの PR を本番へ出す最後の一手 (+ その前の機械チェック)。
#
# WHY this exists:
#   本番反映は「オーナーが `確認した` ラベルを付ける -> main にマージ -> deploy.yml が自動
#   デプロイ」という経路。ゲート自体は CI にあるが、**ゲートが満たされているかを事前に
#   まとめて見るコマンドが無かった**ため、毎回 PR 画面とラベルと staging の状態を人が突き
#   合わせていた。ここが抜けると「staging で見た版と違うものが本番に出る」「マージしたが
#   デプロイの成否を誰も見ていない」が起きる。
#
# 二段構え (既定は READ-ONLY):
#   引数なし  -> ゲート判定を表にして出すだけ。何も変更しない (READY / NOT READY)。
#   --merge   -> ゲート全通過を再確認した上で main にマージし、deploy.yml を待ち、
#                本番 URL に対して verify:live を実測し、deploy-state/prod.json を書く。
#
# 「確認した版そのものが出る」ことの担保 (ラベルの有無だけでは足りない):
#   ラベルは PR に付く恒久フラグなので、承認後にコミットを積めば承認は古くなる。そこで
#     (a) deploy-state/staging.json の deployedSha == PR head SHA  (staging に載っているのが今の head)
#     (b) `確認した` が付いた時刻 >= head コミットの時刻              (承認後に積んでいない)
#     (c) staging の配信バンドルにマーカーが実在
#   の 3 点を判定する。(a)(b) が承認とコミットを紐付ける本体で、(c) はその補助。
#
# 自己承認の禁止 (最重要):
#   このスクリプトは `確認した` ラベルを **絶対に付けない**。ラベルはオーナーだけが付ける
#   もので、それが本番への許可そのもの。ラベルが無ければ --merge でも必ず中断する。
#
# Usage:
#   scripts/promote-prod.sh [--pr <n> | --branch <b>]                 # ゲート判定のみ
#   scripts/promote-prod.sh --pr <n> --merge [--merge-method squash]  # 本番へ出す
#   scripts/promote-prod.sh --pr <n> --skip-staging-check "<理由>"    # 例外: staging 実測を省略
#   scripts/promote-prod.sh --self-test                               # オフライン検証
#
# Exit codes: 0 ok (READY / 本番 LIVE) · 2 usage · 1 前提不足 · 3 not-live ·
#             4 CI が赤/時間切れ · 5 CI run 未生成 · 10 ゲート未達
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/promote-lib.sh
. "${ROOT}/scripts/lib/promote-lib.sh"

CONFIRM_LABEL="確認した"
MANIFEST="deploy-state/prod.json"
STAGING_MANIFEST="deploy-state/staging.json"
WORKFLOW="deploy.yml"

PROMOTE_TMP=""
cleanup() { [ -n "$PROMOTE_TMP" ] && rm -rf "$PROMOTE_TMP"; return 0; }
trap cleanup EXIT

# ゲート判定は純粋関数にしてオフラインで検証できるようにする。
# 引数の true|false|skipped は呼び出し側 (ネットワーク) が確定させた事実。
# 出力: 1 行ずつの判定。戻り値 0 = 全通過, 10 = 未達。
gate_report() {  # <pr-json> <staging_live> <staging_sha_match> <approval_fresh>
  local prj="$1" staging_live="$2" sha_match="$3" approval_fresh="$4" bad=0
  local state draft mergeable merge_state
  state="$(jfield "$prj" state)"
  draft="$(jfield "$prj" isDraft)"
  mergeable="$(jfield "$prj" mergeable)"
  merge_state="$(jfield "$prj" mergeStateStatus)"

  if [ "$state" = "OPEN" ]; then echo "  ✓ PR は open"
  else echo "  ✗ PR が ${state} — open な PR にだけ本番マージできます"; bad=1; fi

  if [ "$draft" = "true" ]; then echo "  ✗ draft PR — ready for review にしてください"; bad=1
  else echo "  ✓ draft ではない"; fi

  # gh から取得済みのマージ可能性を必ず使う。READY と出したのに gh pr merge が生エラーで
  # 落ちる (コンフリクト・必須チェック赤) のは READY の意味が壊れている状態。
  case "$mergeable" in
    MERGEABLE) echo "  ✓ コンフリクト無し" ;;
    CONFLICTING) echo "  ✗ コンフリクトあり — main を取り込んで解消してください"; bad=1 ;;
    *) echo "  - マージ可能性は判定中 (mergeable=${mergeable:-unknown})" ;;
  esac
  case "$merge_state" in
    CLEAN|HAS_HOOKS|UNSTABLE) echo "  ✓ マージ状態 ${merge_state}" ;;
    DIRTY|BLOCKED)  echo "  ✗ マージ状態 ${merge_state} — 必須チェック/保護ルールで止まっています"; bad=1 ;;
    BEHIND)         echo "  - main より古い (BEHIND) — マージ方式によっては更新が要ります" ;;
    QUEUED)         echo "  - merge queue に入っています" ;;
    *)              echo "  - マージ状態 ${merge_state:-unknown}" ;;
  esac

  if has_label "$prj" "$CONFIRM_LABEL"; then echo "  ✓ 「${CONFIRM_LABEL}」ラベルあり (オーナーの本番許可)"
  else
    echo "  ✗ 「${CONFIRM_LABEL}」ラベルが無い — staging 確認 -> オーナーがラベル付与、の順です"
    echo "    (このスクリプトはラベルを代わりに付けません: 自己承認の禁止)"
    bad=1
  fi

  case "$approval_fresh" in
    true)    echo "  ✓ 承認は現在の head コミットに対するもの" ;;
    skipped) echo "  - 承認時刻を判定できず (タイムライン取得不可) — head の新しさは未検証" ;;
    *)       echo "  ✗ 「${CONFIRM_LABEL}」付与より後に新しいコミットがあります — 未確認のコードが本番に出ます"
             echo "    再度 staging に反映し、オーナーに確認し直してもらってください"
             bad=1 ;;
  esac

  case "$sha_match" in
    true)    echo "  ✓ staging に載っているのは PR の現 head (deploy-state/staging.json 一致)" ;;
    skipped) echo "  - staging の SHA 照合はスキップ" ;;
    *)       echo "  ✗ staging に載っているのが別の版です — 確認した版 == 本番に出す版 を保証できません"
             echo "    先に: pnpm deploy:staging --pr <n>"
             bad=1 ;;
  esac

  case "$staging_live" in
    true)    echo "  ✓ staging の配信バンドルにマーカーが実在" ;;
    skipped) echo "  - staging 実測はスキップ" ;;
    *)       echo "  ✗ staging にマーカーが無い — 確認した版が staging に載っていません"; bad=1 ;;
  esac

  [ "$bad" = 0 ] && return 0 || return 10
}

# ---- self-test (offline) -------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fail=0
  MARKERS=()
  MERGE_OK='"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"'
  OK="{\"state\":\"OPEN\",\"isDraft\":false,${MERGE_OK},\"labels\":[{\"name\":\"確認した\"}]}"
  NOLABEL="{\"state\":\"OPEN\",\"isDraft\":false,${MERGE_OK},\"labels\":[{\"name\":\"stagingへ\"}]}"
  DRAFT="{\"state\":\"OPEN\",\"isDraft\":true,${MERGE_OK},\"labels\":[{\"name\":\"確認した\"}]}"
  CLOSED="{\"state\":\"CLOSED\",\"isDraft\":false,${MERGE_OK},\"labels\":[{\"name\":\"確認した\"}]}"
  CONFLICT='{"state":"OPEN","isDraft":false,"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","labels":[{"name":"確認した"}]}'
  BLOCKED='{"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","labels":[{"name":"確認した"}]}'
  chk() { # <desc> <expect-pass:0|1> <args...>
    local desc="$1" expect="$2"; shift 2
    if gate_report "$@" >/dev/null; then
      if [ "$expect" = 0 ]; then echo "  ok  $desc"; else echo "  FAIL $desc (通ってはいけない)"; fail=1; fi
    else
      if [ "$expect" = 1 ]; then echo "  ok  $desc"; else echo "  FAIL $desc (通るべき)"; fail=1; fi
    fi
  }
  chk "all-green -> READY"            0 "$OK"       true    true    true
  chk "確認した 無し -> blocked"       1 "$NOLABEL"  true    true    true
  chk "staging not live -> blocked"   1 "$OK"       false   true    true
  chk "staging SHA 不一致 -> blocked"  1 "$OK"       true    false   true
  chk "承認後コミット -> blocked"      1 "$OK"       true    true    false
  chk "draft -> blocked"              1 "$DRAFT"    true    true    true
  chk "closed -> blocked"             1 "$CLOSED"   true    true    true
  chk "conflict -> blocked"           1 "$CONFLICT" true    true    true
  chk "blocked state -> blocked"      1 "$BLOCKED"  true    true    true
  chk "skip 可能な項目は通る"          0 "$OK"       skipped skipped skipped

  # 承認の新しさ判定 (ISO-8601 UTC の辞書順比較)
  iso_newer 2026-09-22T14:08:49Z 2026-09-22T14:08:48Z || { echo "  FAIL iso_newer strictly-newer"; fail=1; }
  if iso_newer 2026-09-22T14:08:48Z 2026-09-22T14:08:49Z; then echo "  FAIL iso_newer older"; fail=1; fi
  if iso_newer "" 2026-09-22T14:08:49Z; then echo "  FAIL iso_newer empty"; fail=1; fi

  # 自己承認の禁止を機械で保証する: このスクリプトにも sourced ライブラリにもラベル付与の
  # 経路が無いこと。検査パターン自身がヒットしないよう add[-]label と書いてある。
  if grep -qE 'add[-]label|issues/[^ ]*/labels|gh +label|--field +labels' \
      "${BASH_SOURCE[0]}" "${ROOT}/scripts/lib/promote-lib.sh"; then
    echo "  FAIL a label-adding path exists in promote-prod.sh or promote-lib.sh"; fail=1
  else
    echo "  ok  no label-adding path in promote-prod.sh / promote-lib.sh"
  fi

  case "$(fe2_origin_for prod)" in https://dub-fe2-app-shell.*.workers.dev) : ;;
    *) echo "  FAIL prod origin"; fail=1 ;; esac
  PROMOTE_TMP="$(mktemp -d)"
  parse_markers 'p1'
  write_env_manifest "$PROMOTE_TMP/p.json" prod https://x sha main me true ok
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.env!=="prod"||j.live!==true)process.exit(1)' "$PROMOTE_TMP/p.json" \
    || { echo "  FAIL prod manifest"; fail=1; }
  if [ "$fail" = 0 ]; then echo "promote-prod self-test: PASS"; exit 0
  else echo "promote-prod self-test: FAIL"; exit 1; fi
fi

# ---- args ------------------------------------------------------------------------------
PR_REF=""; BRANCH_ARG=""; MARKERS_CSV=""; DO_MERGE=0; MERGE_METHOD="squash"; SKIP_STAGING=""; WAIT=1
declare -a MARKERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)                 PR_REF="${2:?}"; shift 2 ;;
    --branch)             BRANCH_ARG="${2:?}"; shift 2 ;;
    --markers)            MARKERS_CSV="${2:?}"; shift 2 ;;
    --merge)              DO_MERGE=1; shift ;;
    --merge-method)       MERGE_METHOD="${2:?}"; shift 2 ;;
    # バイパスには理由を必須にする (日常運用でフラグが常用化するのを防ぐ)。
    --skip-staging-check) SKIP_STAGING="${2:?--skip-staging-check には理由を書いてください (例: 'staging は PR #545 が占有中')}"; shift 2 ;;
    --no-wait)            WAIT=0; shift ;;
    -h|--help)            sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "::error::unknown arg '$1'" >&2; exit 2 ;;
  esac
done
case "$MERGE_METHOD" in squash|merge|rebase) : ;; *) echo "::error::--merge-method は squash|merge|rebase" >&2; exit 2 ;; esac

cd "$ROOT"
require_gh

REF="$PR_REF"
if [ -z "$REF" ]; then REF="${BRANCH_ARG:-$(git rev-parse --abbrev-ref HEAD)}"; fi
PRJ="$(pr_json "$REF")"
if [ -z "$PRJ" ]; then
  echo "::error::'${REF}' に対応する PR がありません。本番反映は PR 経由のみです。" >&2
  exit 1
fi
PR_NUM="$(jfield "$PRJ" number)"
PR_URL="$(jfield "$PRJ" url)"
PR_BODY="$(jfield "$PRJ" body)"
HEAD_REF="$(jfield "$PRJ" headRefName)"
HEAD_SHA="$(jfield "$PRJ" headRefOid)"
MERGE_STATE="$(jfield "$PRJ" mergeStateStatus)"
ACTOR="$(git config user.name 2>/dev/null || echo "${USER:-unknown}")"
PROD_URL="$(fe2_origin_for prod)"

if [ -z "$MARKERS_CSV" ]; then MARKERS_CSV="$(marker_trailer "$PR_BODY")"; fi
if [ -n "$MARKERS_CSV" ]; then parse_markers "$MARKERS_CSV"; fi

echo "本番反映ゲート: PR #${PR_NUM} (${HEAD_REF} @ ${HEAD_SHA})"
echo "  ${PR_URL}"
echo ""

# ---- (b) 承認の新しさ: 「確認した」付与より後のコミットが無いか -----------------------------
# ラベルは PR に付く恒久フラグなので、これが無いと「承認 -> さらに push -> 本番」が通ってしまう。
APPROVAL_FRESH="skipped"
LABEL_AT="$(gh api "repos/{owner}/{repo}/issues/${PR_NUM}/timeline" --paginate \
  --jq "[.[] | select(.event == \"labeled\" and .label.name == \"${CONFIRM_LABEL}\") | .created_at] | last" \
  2>/dev/null || true)"
HEAD_AT="$(gh pr view "$PR_NUM" --json commits --jq '[.commits[].committedDate] | max' 2>/dev/null || true)"
if [ -n "$LABEL_AT" ] && [ "$LABEL_AT" != "null" ] && [ -n "$HEAD_AT" ] && [ "$HEAD_AT" != "null" ]; then
  if iso_newer "$HEAD_AT" "$LABEL_AT"; then APPROVAL_FRESH=false; else APPROVAL_FRESH=true; fi
  echo "  承認: ${LABEL_AT} / 最新コミット: ${HEAD_AT}"
fi

# ---- (a)(c) staging に載っているのが「今の head」であることの裏取り -------------------------
STAGING_LIVE="skipped"; STAGING_SHA_MATCH="skipped"
if [ -n "$SKIP_STAGING" ]; then
  echo "::warning::staging チェックをスキップします — 理由: ${SKIP_STAGING}"
else
  STAGING_SHA="$(manifest_field "$STAGING_MANIFEST" deployedSha)"
  if [ -z "$STAGING_SHA" ]; then
    echo "  ${STAGING_MANIFEST} に deployedSha がありません (pnpm deploy:staging 未実行)"
    STAGING_SHA_MATCH=false
  elif [ "$STAGING_SHA" = "$HEAD_SHA" ]; then
    STAGING_SHA_MATCH=true
  else
    echo "  staging の版: ${STAGING_SHA} / PR head: ${HEAD_SHA}"
    STAGING_SHA_MATCH=false
  fi
  if [ "${#MARKERS[@]}" -eq 0 ]; then
    echo "::warning::マーカーが無い (PR 本文に Liveness-Marker: が無く --markers も未指定) ため staging 実測は行いません。"
  else
    echo "::group::staging liveness ($(fe2_origin_for staging))"
    if bash scripts/verify-live.sh staging ${MARKERS[@]+"${MARKERS[@]}"}; then STAGING_LIVE=true; else STAGING_LIVE=false; fi
    echo "::endgroup::"
  fi
fi

echo ""
echo "ゲート判定:"
GATE_OK=0
gate_report "$PRJ" "$STAGING_LIVE" "$STAGING_SHA_MATCH" "$APPROVAL_FRESH" || GATE_OK=$?

if [ "$GATE_OK" != 0 ]; then
  echo ""
  echo "NOT READY — 本番へは進めません (exit 10)."
  exit 10
fi

echo ""
if [ "$DO_MERGE" = 0 ]; then
  echo "READY ✅ — ゲートは全通過しています。本番へ出すには (オーナーの指示があるときだけ):"
  echo "  pnpm ship:prod --pr ${PR_NUM} --merge"
  echo "(このコマンドは既定では何も変更しません。)"
  exit 0
fi

# ---- 本番へ: main にマージ -> deploy.yml -> 本番 URL の実測 ------------------------------
echo "main へマージします (${MERGE_METHOD})..."
gh pr merge "$PR_NUM" --"$MERGE_METHOD" >/dev/null
echo "  ✓ merged"

MERGE_SHA=""
i=0
while [ "$i" -lt 12 ]; do
  MERGE_SHA="$(gh pr view "$PR_NUM" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null || true)"
  if [ -n "$MERGE_SHA" ] && [ "$MERGE_SHA" != "null" ]; then break; fi
  MERGE_SHA=""; i=$((i + 1)); sleep 5
done
if [ -z "$MERGE_SHA" ]; then
  if [ "$MERGE_STATE" = "QUEUED" ] || [ "$(jfield "$(pr_json "$PR_NUM")" mergeStateStatus)" = "QUEUED" ]; then
    echo "::warning::この PR は merge queue に入りました。キューがマージするまで commit SHA は確定しません。"
    echo "  キュー処理後に ${WORKFLOW} が走ります: gh run list --workflow ${WORKFLOW} --branch main"
    exit 0
  fi
  echo "::error::マージ commit の SHA を解決できませんでした。Actions タブで ${WORKFLOW} を直接確認してください。" >&2
  exit 4
fi
echo "  merge commit: ${MERGE_SHA}"

if [ "$WAIT" = 0 ]; then
  echo "[--no-wait] deploy.yml の完了を待っていません: gh run list --workflow ${WORKFLOW} --commit ${MERGE_SHA}"
  exit 0
fi

rc=0
wait_for_new_run "$WORKFLOW" "$MERGE_SHA" "" "production deploy" || rc=$?
if [ "$rc" != 0 ]; then
  echo "::error::本番デプロイ (${WORKFLOW}) が完了しませんでした。" >&2
  exit "$rc"
fi
echo "  ✓ ${WORKFLOW} 完了"

live=true
if [ "${#MARKERS[@]}" -gt 0 ]; then
  echo "::group::post-deploy liveness (served ${PROD_URL})"
  if bash scripts/verify-live.sh prod ${MARKERS[@]+"${MARKERS[@]}"}; then live=true; else live=false; fi
  echo "::endgroup::"
else
  echo "::warning::マーカー未指定のため本番の実測はスキップしました。"
fi

write_env_manifest "$MANIFEST" prod "$PROD_URL" "$MERGE_SHA" main "$ACTOR" "$live" \
  "PR #${PR_NUM} shipped via promote-prod.sh"
echo "manifest written: ${MANIFEST} (live=${live})"

if [ "$live" != true ]; then
  echo "::error::本番にマーカーが見つかりません。デプロイ内容を確認してください。" >&2
  exit 3
fi

echo ""
echo "本番 LIVE ✅  ${PROD_URL}  (PR #${PR_NUM}, sha ${MERGE_SHA})"
echo "台帳を記録: git add ${MANIFEST} && git commit -m 'chore(deploy-state): prod = PR #${PR_NUM}'"
