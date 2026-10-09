// 完了レーン専用の一覧。アーカイブ済みは増え続ける一方で "もう触らない" ので、フルカードではなく
// 「タイトル / PR」の key-value を 1 行に詰めて並べ、検索で絞り込めるようにする。
// 行クリックで通常カードと同じくドロワーを開く(履歴の参照はできる)。
import { useMemo, useState } from "react";
import type { BoardItem } from "./lib/commanderApi.ts";
import { input, t } from "./lib/theme.ts";

interface DoneListProps {
  items: BoardItem[];
  onOpen: (taskId: string) => void;
}

/** "https://github.com/o/r/pull/573" -> "#573"（取れなければ URL そのまま）。 */
export function prLabel(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : url;
}

function prsOf(item: BoardItem): string[] {
  if (item.prUrls.length > 0) return item.prUrls;
  return item.prUrl ? [item.prUrl] : [];
}

/** タイトル・PR 番号・PR URL のいずれかに部分一致(大小無視)。 */
export function matchesDone(item: BoardItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.title, ...prsOf(item).flatMap((u) => [u, prLabel(u)])].join("\n").toLowerCase();
  return hay.includes(q);
}

const keyStyle = { color: t.textMuted, fontSize: 11, flexShrink: 0 } as const;

export function DoneList({ items, onOpen }: DoneListProps) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => items.filter((i) => matchesDone(i, query)), [items, query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
      <input
        type="search"
        data-testid="done-search"
        aria-label="完了タスクを検索"
        placeholder="タイトル / PR で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ ...input, fontSize: 12, padding: `${t.space1} ${t.space2}` }}
      />
      {visible.length === 0 ? (
        <div data-testid="done-no-match" style={{ fontSize: 12, color: t.textMuted, padding: t.space2 }}>
          一致なし
        </div>
      ) : (
        visible.map((item) => {
          const prs = prsOf(item);
          const latest = item.prUrl ?? prs[prs.length - 1];
          return (
            <div
              key={item.taskId}
              role="button"
              tabIndex={0}
              aria-label={`${item.title} を開く`}
              data-testid={`task-card-${item.taskId}`}
              title={item.title}
              onClick={() => onOpen(item.taskId)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                  e.preventDefault();
                  onOpen(item.taskId);
                }
              }}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: t.space2,
                padding: `${t.space1} ${t.space2}`,
                borderRadius: "var(--dub-radius-sm, 8px)",
                borderLeft: `2px solid ${t.border}`,
                fontSize: 12,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              <span style={keyStyle}>タイトル</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.title}
              </span>
              <span style={keyStyle}>PR</span>
              {latest ? (
                <a
                  href={latest}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`done-pr-${item.taskId}`}
                  title={prs.join("\n")}
                  onClick={(e) => e.stopPropagation()}
                  style={{ color: "inherit", flexShrink: 0 }}
                >
                  {prLabel(latest)}
                  {prs.length > 1 && <span style={{ color: t.textMuted }}> +{prs.length - 1}</span>}
                </a>
              ) : (
                <span style={{ color: t.textMuted, flexShrink: 0 }}>—</span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
