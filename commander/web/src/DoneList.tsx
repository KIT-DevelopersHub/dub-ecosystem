// 完了レーン専用の一覧。アーカイブ済みは増え続ける一方で "もう触らない" ので、フルカードではなく
// 「タイトル / PR」を 1 行に詰めて並べる。絞り込みはボード上部のフィルターで全レーン共通に行う。
// 行クリックで通常カードと同じくドロワーを開く(履歴の参照はできる)。
import type { BoardItem } from "./lib/commanderApi.ts";
import { prLabel, prsOf } from "./lib/filter.ts";
import { t } from "./lib/theme.ts";

interface DoneListProps {
  items: BoardItem[];
  onOpen: (taskId: string) => void;
}

export function DoneList({ items, onOpen }: DoneListProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space1 }}>
      {items.map((item) => {
        const prs = prsOf(item);
        const latest = item.prUrl ?? prs[prs.length - 1];
        return (
          <div
            key={item.taskId}
            role="button"
            tabIndex={0}
            aria-label={`${item.title} を開く`}
            data-testid={`task-card-${item.taskId}`}
            className="cmdr-row"
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
              padding: `${t.space2} ${t.space2}`,
              borderRadius: "var(--dub-radius-sm, 8px)",
              fontSize: 13,
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            <span aria-hidden style={{ color: t.success, flexShrink: 0 }}>
              ✓
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {item.title}
            </span>
            {latest ? (
              <a
                href={latest}
                target="_blank"
                rel="noreferrer"
                data-testid={`done-pr-${item.taskId}`}
                title={prs.join("\n")}
                onClick={(e) => e.stopPropagation()}
                style={{ color: t.textMuted, flexShrink: 0, fontSize: 12 }}
              >
                {prLabel(latest)}
                {prs.length > 1 && <span> +{prs.length - 1}</span>}
              </a>
            ) : (
              <span style={{ color: t.textMuted, flexShrink: 0, fontSize: 12 }}>PR なし</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
