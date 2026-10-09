// Board-wide keyword filter (GitHub Project の "Filter by keyword" 相当)。全レーン共通。
import type { BoardItem } from "./commanderApi.ts";

/** "https://github.com/o/r/pull/573" -> "#573"（取れなければ URL そのまま）。 */
export function prLabel(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : url;
}

export function prsOf(item: BoardItem): string[] {
  if (item.prUrls.length > 0) return item.prUrls;
  return item.prUrl ? [item.prUrl] : [];
}

/** 空白区切りの全語が タイトル / PR 番号・URL / 作業フォルダ のどこかに部分一致(大小無視)。 */
export function matchesFilter(item: BoardItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    item.title,
    item.latestRun?.cwd ?? "",
    ...prsOf(item).flatMap((u) => [u, prLabel(u)]),
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => hay.includes(term));
}
