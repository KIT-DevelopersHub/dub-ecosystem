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
