// 合体（staging 束）のカード。stg 列の中に 1 枚で置き、子タスクを入れ子の行で見せる。
// 子の行をクリックするとその子のいつものドロワー（履歴・承認・却下）が開く＝履歴は子ごとのまま。
import type { BoardItem, StagingBundle } from "./lib/commanderApi.ts";
import { LANE_COLORS, needsFix, NEEDS_FIX_COLOR } from "./lib/lanes.ts";
import { bundleLane } from "./lib/bundles.ts";
import { prLabel } from "./TaskDrawer.tsx";
import { Spinner } from "./Spinner.tsx";
import { t } from "./lib/theme.ts";

export const BUNDLE_COLOR = "var(--dub-color-accent-500, #8b5cf6)";

const SLOT_LABEL = { staging: "枠1", staging2: "枠2" } as const;

const MARKER = {
  pending: { icon: "…", label: "反映を確認中", color: t.textMuted },
  pass: { icon: "✓", label: "反映を確認済み", color: t.success },
  missing: { icon: "✕", label: "反映が見つからない", color: t.danger },
} as const;

interface BundleCardProps {
  bundle: StagingBundle;
  /** 束の子（bundleChildren で解決済み）。 */
  items: BoardItem[];
  onOpenChild: (taskId: string) => void;
  onDissolve: (bundleId: string) => void;
}

export function BundleCard({ bundle, items, onOpenChild, onDissolve }: BundleCardProps) {
  const merging = bundle.status === "merging";
  const failed = bundle.status === "failed";
  const accent = failed ? NEEDS_FIX_COLOR : LANE_COLORS[bundleLane(bundle)];
  return (
    <section
      data-testid={`bundle-card-${bundle.id}`}
      aria-label={`合体 ${items.length} 件`}
      style={{
        background: t.surface,
        border: `1px solid ${failed ? NEEDS_FIX_COLOR : t.border}`,
        borderLeft: `3px solid ${BUNDLE_COLOR}`,
        borderRadius: "var(--dub-radius-sm, 8px)",
        padding: t.space3,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: t.space2, fontSize: 12, color: t.textMuted }}>
        {merging ? (
          <Spinner size={12} color={accent} />
        ) : (
          <span aria-hidden style={{ color: BUNDLE_COLOR, fontWeight: 700 }}>⧉</span>
        )}
        <span
          data-testid={`bundle-badge-${bundle.id}`}
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: BUNDLE_COLOR,
            border: `1px solid ${BUNDLE_COLOR}`,
            borderRadius: 999,
            padding: "0 8px",
            lineHeight: "18px",
            whiteSpace: "nowrap",
          }}
        >
          {merging ? "合体中" : "合体"} · {items.length} 件
        </span>
        {bundle.slot && <span style={{ whiteSpace: "nowrap" }}>{SLOT_LABEL[bundle.slot]}</span>}
      </div>

      {merging && (
        <div
          data-testid={`bundle-merging-${bundle.id}`}
          style={{ marginTop: t.space2, fontSize: 12, fontWeight: 600, color: LANE_COLORS.staging_deploying }}
        >
          まとめて staging に反映中…
        </div>
      )}
      {failed && (
        <div style={{ marginTop: t.space2, fontSize: 12, fontWeight: 600, color: NEEDS_FIX_COLOR }}>
          反映に失敗しました。解除して個別に戻せます
        </div>
      )}

      <ul style={{ listStyle: "none", margin: `${t.space2} 0 0`, padding: 0, display: "flex", flexDirection: "column", gap: t.space1 }}>
        {items.map((item) => {
          const marker = MARKER[bundle.markers[item.taskId] ?? "pending"];
          const fix = needsFix(item);
          return (
            <li key={item.taskId}>
              <button
                type="button"
                className="cmdr-row"
                data-testid={`bundle-child-${item.taskId}`}
                onClick={() => onOpenChild(item.taskId)}
                title={`${item.title} を開く（履歴・承認・却下）`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: t.space2,
                  width: "100%",
                  textAlign: "left",
                  background: t.sunken,
                  border: `1px solid ${fix ? NEEDS_FIX_COLOR : t.border}`,
                  borderRadius: "var(--dub-radius-sm, 8px)",
                  padding: `${t.space2} ${t.space2}`,
                  color: "inherit",
                  font: "inherit",
                  cursor: "pointer",
                }}
              >
                <span
                  aria-label={marker.label}
                  title={marker.label}
                  style={{ width: 14, textAlign: "center", color: marker.color, fontWeight: 700, fontSize: 12 }}
                >
                  {marker.icon}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>
                  {item.title}
                </span>
                {item.prUrl && (
                  <span style={{ fontSize: 12, color: t.textMuted, whiteSpace: "nowrap" }}>{prLabel(item.prUrl)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div style={{ display: "flex", alignItems: "center", gap: t.space2, marginTop: t.space2, fontSize: 12 }}>
        {bundle.stagingUrl && !merging && (
          <a
            href={bundle.stagingUrl}
            target="_blank"
            rel="noreferrer"
            data-testid={`bundle-staging-${bundle.id}`}
            style={{ color: t.primary, fontWeight: 600, textDecoration: "none" }}
          >
            🌐 stagingを確認
          </a>
        )}
        <button
          type="button"
          className="cmdr-cancel"
          data-testid={`bundle-dissolve-${bundle.id}`}
          onClick={() => onDissolve(bundle.id)}
          style={{
            marginLeft: "auto",
            fontSize: 12,
            color: t.textMuted,
            background: "transparent",
            border: `1px solid ${t.border}`,
            borderRadius: "var(--dub-radius-sm, 8px)",
            padding: `1px ${t.space2}`,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          合体を解除
        </button>
      </div>
      {!merging && (
        <div style={{ marginTop: t.space2, fontSize: 11, color: t.textMuted }}>
          承認・却下はタスクごと（行を開く）
        </div>
      )}
    </section>
  );
}
