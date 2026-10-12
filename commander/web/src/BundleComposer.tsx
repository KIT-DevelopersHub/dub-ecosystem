// 合体の確認ドロワー。選んだタスクを並べ、合体前チェック（衝突・D1 マイグレーション・
// メール系の枠制約）の結果を見せてから「合体して staging へ」を押させる。
import { useEffect, useState } from "react";
import { Drawer } from "./Drawer.tsx";
import type { BoardItem, BundleApi, BundleIssue } from "./lib/commanderApi.ts";
import { prLabel } from "./TaskDrawer.tsx";
import { Spinner } from "./Spinner.tsx";
import { btnGhost, btnPrimary, t } from "./lib/theme.ts";

interface BundleComposerProps {
  open: boolean;
  items: BoardItem[];
  api: BundleApi;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function BundleComposer({ open, items, api, onClose, onConfirm }: BundleComposerProps) {
  const [issues, setIssues] = useState<BundleIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const key = items.map((i) => i.taskId).join(",");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setIssues(null);
    api
      .checkBundle(key.split(","))
      .then((r) => alive && setIssues(r))
      .catch(() => alive && setIssues([{ taskIds: [], message: "チェックに失敗しました", block: true }]));
    return () => {
      alive = false;
    };
  }, [open, key, api]);

  const blocked = !issues || issues.some((i) => i.block);
  const titleOf = (id: string) => items.find((i) => i.taskId === id)?.title ?? id;

  return (
    <Drawer open={open} onClose={onClose} title={`${items.length} 件を合体して staging へ`} testId="bundle-composer">
      <p style={{ marginTop: 0, fontSize: 13, color: t.textMuted, lineHeight: 1.6 }}>
        選んだタスクの PR を 1 本の統合ブランチにまとめ、空いている staging 枠 1 つに載せます。
        各タスクの履歴・PR・承認はそのまま残り、staging での承認・却下もタスクごとに行います。
      </p>

      <h3 style={{ fontSize: 13, margin: `${t.space4} 0 ${t.space2}` }}>合体するタスク</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: t.space2 }}>
        {items.map((i) => (
          <li
            key={i.taskId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: t.space2,
              padding: t.space3,
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: "var(--dub-radius-sm, 8px)",
              fontSize: 13,
            }}
          >
            <span style={{ flex: 1, fontWeight: 600 }}>{i.title}</span>
            {i.prUrl && <span style={{ color: t.textMuted }}>{prLabel(i.prUrl)}</span>}
          </li>
        ))}
      </ul>

      <h3 style={{ fontSize: 13, margin: `${t.space5} 0 ${t.space2}` }}>合体前チェック</h3>
      <div data-testid="bundle-check" role="status" style={{ fontSize: 13, lineHeight: 1.6 }}>
        {!issues ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: t.space2, color: t.textMuted }}>
            <Spinner size={12} color={t.textMuted} /> 衝突・マイグレーション・枠の制約を確認中…
          </span>
        ) : issues.length === 0 ? (
          <span style={{ color: t.success, fontWeight: 600 }}>✓ 問題なし。まとめて載せられます</span>
        ) : (
          <ul style={{ margin: 0, paddingLeft: t.space4 }}>
            {issues.map((iss, n) => (
              <li key={n} style={{ color: iss.block ? t.danger : t.warning }}>
                {iss.block ? "✕ " : "! "}
                {iss.message}
                {iss.taskIds.length > 0 && (
                  <span style={{ color: t.textMuted }}>（{iss.taskIds.map(titleOf).join(" / ")}）</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2, marginTop: t.space6 }}>
        <button type="button" onClick={onClose} style={btnGhost}>
          キャンセル
        </button>
        <button
          type="button"
          data-testid="bundle-confirm"
          disabled={blocked || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
          style={{ ...btnPrimary, opacity: blocked || busy ? 0.5 : 1, cursor: blocked || busy ? "not-allowed" : "pointer" }}
        >
          {busy ? "合体中…" : "合体して staging へ"}
        </button>
      </div>
    </Drawer>
  );
}
