// staging 合体の純粋ロジック。束は列を増やさず（8 列固定）、stg 列の中の 1 枚のカードとして
// 置く。子タスクは束の中に入れ子で表示し、元の列からは消す（同じタスクを 2 か所に出さない）。
import type { BoardItem, StagingBundle } from "./commanderApi.ts";
import { isArchived, needsFix, type Lane } from "./lanes.ts";

/**
 * 合体の候補になれるか。demo 承認済み（staging 段）で、まだどの枠にも載っていない
 * （stagingUrl 無し）＝枠待ちのタスクだけ。合体には PR が要る。
 */
export function bundleBlocker(item: BoardItem): string | null {
  if (isArchived(item)) return "アーカイブ済み";
  if (item.featurePhase !== "staging_deployed" && item.featurePhase !== "staging_review") {
    return "demo 承認前";
  }
  if (needsFix(item)) return "要修正";
  if (item.stagingUrl) return "staging に反映済み";
  if (!item.prUrl) return "PR がまだ無い";
  return null;
}

export function isBundleCandidate(item: BoardItem): boolean {
  return bundleBlocker(item) === null;
}

/** 束カードを置く列。統合〜反映中は stg反映中、それ以外は stg確認待ち。 */
export function bundleLane(bundle: StagingBundle): Lane {
  return bundle.status === "merging" ? "staging_deploying" : "staging_review";
}

/** taskId → 所属する束。 */
export function bundleOfTask(bundles: StagingBundle[]): Map<string, StagingBundle> {
  const out = new Map<string, StagingBundle>();
  for (const b of bundles) for (const id of b.taskIds) out.set(id, b);
  return out;
}

/** 束に入っていないタスクだけを残す（入っているものは束カードの中に出す）。 */
export function withoutBundled(items: BoardItem[], bundles: StagingBundle[]): BoardItem[] {
  const inBundle = bundleOfTask(bundles);
  return items.filter((i) => !inBundle.has(i.taskId));
}

/** 束が持つ子の BoardItem（束の並び順・既に消えた子は除く）。 */
export function bundleChildren(bundle: StagingBundle, items: BoardItem[]): BoardItem[] {
  const byId = new Map(items.map((i) => [i.taskId, i]));
  return bundle.taskIds.map((id) => byId.get(id)).filter((i): i is BoardItem => !!i);
}

/** 束を統合して staging に載せる run の prompt。最終行の BUNDLE_RESULT が束に反映される。 */
export function bundleDeployPrompt(bundle: StagingBundle, children: BoardItem[]): string {
  const list = children.map((c) => `- ${c.taskId} / ${c.title} / ${c.prUrl ?? "(PR なし)"}`).join("\n");
  return [
    `[commander] staging 合体（${bundle.id}）: 次の ${children.length} 件の demo 承認済み PR を 1 本の統合ブランチにまとめ、空いている staging 枠 1 つに載せてください。`,
    "",
    "対象（taskId / タイトル / PR）:",
    list,
    "",
    "手順:",
    `1. git fetch origin のあと、新しい worktree で origin/main から \`${bundle.branch}\` を切り、各 PR の head を上から順に \`git merge --no-ff\` する。衝突したら解決せずに中止する。infra/d1/migrations 配下にファイルを足す PR があれば中止する（staging の D1 は手作業のため合体しない）。`,
    `2. push して PR を作る。タイトルは「[合体・マージ禁止] ${bundle.branch}」、本文に子 PR の一覧と、各子 PR 本文の Liveness-Marker を並べる。この PR は絶対にマージせず、\`確認した\` ラベルも付けない。`,
    "3. `bash scripts/staging-pick-slot.sh --pr <統合PRの番号>` で枠を選び、出力の label を統合 PR に付けて staging.yml の完了を待つ。両方の枠が埋まっていれば、空くまで 5 分おきに再実行して待つ（最大 60 分）。",
    "4. 各子 PR 本文の `Liveness-Marker:` を、子ごとに `bash scripts/verify-live.sh <出力の verify_env> \"<マーカー>\"` で実測する（マーカーは 1 つずつ別引数）。マーカーが無い子は missing とする。",
    "5. 子 PR のマージ・ラベル付与・フェーズの変更はしない。報告は日本語で簡潔に。",
    "",
    "報告の最後の行は、成否にかかわらず必ず次の形の 1 行にする（JSON は 1 行・status は deployed か failed）:",
    `BUNDLE_RESULT {"status":"deployed","slot":"staging2","stagingUrl":"<出力の fe2>","prUrl":"<統合PRのURL>","markers":{${children.map((c) => `"${c.taskId}":"pass"`).join(",")}}}`,
  ].join("\n");
}

/** 束を解除した時（または子が全員抜けた時）に、統合 PR とブランチを片付ける run の prompt。 */
export function bundleCleanupPrompt(bundle: StagingBundle): string {
  return [
    `[commander] staging 合体（${bundle.id}）を解除しました。後片付けをしてください。`,
    `- ブランチ \`${bundle.branch}\` の open PR${bundle.prUrl ? `（${bundle.prUrl}）` : ""}があれば、staging のラベルを外して close し、リモートブランチを削除する。`,
    "- 子タスクの PR には一切触らない（マージ・ラベル変更・close をしない）。",
    "- 報告は日本語で 1〜2 行。",
  ].join("\n");
}
