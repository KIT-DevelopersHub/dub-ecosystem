// Workspace search results dropdown, anchored under the channel header. Shows
// matching messages grouped nowhere fancy — a flat, newest-first list with the
// channel name, author, and a snippet. Clicking a hit navigates to that channel.
import type { common, identity } from "@dub/types";
import type { SearchHit } from "../api/contract";
import styles from "../styles/chat.module.css";

export interface SearchResultsProps {
  query: string;
  loading: boolean;
  results: SearchHit[];
  resolveUser?: (id: common.UserId) => identity.UserSummary | undefined;
  onSelect: (hit: SearchHit) => void;
  onClose: () => void;
}

function snippet(body: string, q: string): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return body.slice(0, 100);
  const start = Math.max(0, idx - 24);
  return (start > 0 ? "…" : "") + body.slice(start, start + 100);
}

function timeShort(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SearchResults({ query, loading, results, resolveUser, onSelect, onClose }: SearchResultsProps) {
  // System posts (authorId null) render as "システム" — never pass null downstream.
  const nameOf = (id: common.UserId | null): string => (id === null ? "システム" : (resolveUser?.(id)?.displayName ?? id));
  return (
    <div className={styles.searchResults} data-testid="fe6-search-results">
      <div className={styles.searchResultsHead}>
        <span>
          「{query}」の検索結果 · {results.length}件
        </span>
        <button type="button" className={styles.searchClose} aria-label="検索を閉じる" onClick={onClose}>
          ✕
        </button>
      </div>
      {loading ? (
        <div className={styles.searchEmpty}>検索中…</div>
      ) : results.length === 0 ? (
        <div className={styles.searchEmpty} data-testid="fe6-search-empty">
          一致するメッセージはありません
        </div>
      ) : (
        <ul className={styles.searchList}>
          {results.map((h) => (
            <li key={h.message.id}>
              <button type="button" className={styles.searchHit} data-testid="fe6-search-hit" onClick={() => onSelect(h)}>
                <div className={styles.searchHitMeta}>
                  <span className={styles.searchHitChannel}>{h.channelType === "dm" ? "@" : "#"}{h.channelName}</span>
                  <span className={styles.searchHitAuthor}>{nameOf(h.message.authorId)}</span>
                  <span className={styles.searchHitTime}>{timeShort(h.message.createdAt)}</span>
                </div>
                <div className={styles.searchHitBody}>{snippet(h.message.body, query)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
