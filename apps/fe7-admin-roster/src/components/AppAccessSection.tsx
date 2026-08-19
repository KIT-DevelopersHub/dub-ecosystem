import type { identity, chat } from "@dub/types";
import { Badge, SegmentedControl, Switch } from "@dub/ui";
import type { SegmentedOption } from "@dub/ui";
import {
  appAccessRows,
  appAccessLevel,
  appAccessSummary,
  setAppAccessLevel,
  toggleAppEnabled,
  type AppAccessLevel,
  type AppAccessRow,
} from "../lib/appAccessMatrix";
import { chatDeleteRight, setChatDeleteRight, type ChatDeleteRight } from "../lib/chatDeleteRight";

// Chat-only extras folded into the チャット row: the 削除権限 3-choice (owns
// chat:delete / chat:moderate in `selected`) + the 削除時の挙動 toggle (org-wide policy,
// tier-bound — passed in because it is NOT a role permission key).
export interface ChatDeletionControls {
  behavior: chat.MessageDeletionMode; // current mode for this role's tier (org policy)
  onBehaviorChange: (mode: chat.MessageDeletionMode) => void;
  behaviorDisabled?: boolean;
}

const DELETE_RIGHT_OPTIONS: { value: ChatDeleteRight; label: string }[] = [
  { value: "none", label: "削除権限なし" },
  { value: "own", label: "削除あり" },
  { value: "any", label: "複数削除あり" },
];
const DELETE_MODE_OPTIONS: { value: chat.MessageDeletionMode; label: string }[] = [
  { value: "tombstone", label: "痕跡を残す" },
  { value: "hard", label: "完全に消す" },
];

// PER-APP access tier of the role matrix (catalog domain "app"). Instead of showing
// the 22 flat app:<id>:view / app:<id>:edit toggles, this folds them into the product
// UX the coordinator specified: one 有効化 Switch per app that, when ON, discloses a
// nested indented 「閲覧まで / 編集・作成まで」 selector. Turning an app OFF collapses the
// nested selector (消えて畳まれる). Every app — including ガント and 参加届 that used to ride
// a shared domain key — now has its OWN row, so an admin can grant/revoke each app to a
// role individually. Purely presentational; all set logic lives in lib/appAccessMatrix.
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  background: "var(--dub-color-surface-base, #ffffff)",
};
const legendRowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", width: "100%" };
const groupTitleStyle: React.CSSProperties = { fontWeight: 700, fontSize: 15 };
const groupHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, marginTop: 2, lineHeight: 1.45 };
const countStyle: React.CSSProperties = { marginLeft: "auto", color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 13 };

const rowBaseStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 10px",
  borderRadius: 6,
  border: "1px solid transparent",
};
const rowOnStyle: React.CSSProperties = {
  background: "var(--dub-color-success-50, #ecfdf3)",
  border: "1px solid var(--dub-color-success-200, #abefc6)",
};
const rowHeadStyle: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center" };
const switchWrapStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
const nameStyle: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const keyHintStyle: React.CSSProperties = {
  color: "var(--dub-color-text-muted, #6f7a90)",
  fontSize: 11,
  fontFamily: "var(--dub-font-family-mono, monospace)",
};
const openHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11 };
const badgeWrapStyle: React.CSSProperties = { flex: "none" };
// Nested (indented) level selector — visually reads as a child of the enable toggle.
const nestStyle: React.CSSProperties = {
  marginLeft: 46,
  paddingLeft: 12,
  borderLeft: "2px solid var(--dub-color-border-default, #dde1e9)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const nestLabelStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12 };
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))",
  gap: 4,
};

const LEVEL_OPTIONS: { value: AppAccessLevel; label: string }[] = [
  { value: "view", label: "閲覧まで" },
  { value: "edit", label: "編集・作成まで" },
];

function levelBadge(level: AppAccessLevel): { tone: "success" | "neutral"; text: string } {
  if (level === "edit") return { tone: "success", text: "編集・作成" };
  if (level === "view") return { tone: "success", text: "閲覧" };
  return { tone: "neutral", text: "無効" };
}

export function AppAccessSection({
  selected,
  disabled,
  onChange,
  idPrefix = "fe7",
  lockedKeys = [],
  chatDeletion,
}: {
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  idPrefix?: string;
  // Per-app access keys that must stay granted (e.g. app:admin:view/edit on the admin
  // role) — the enable toggle + level selector are frozen ON to prevent self-lockout.
  lockedKeys?: readonly identity.PermissionKey[];
  // Chat-only: the 削除時の挙動 toggle (org-wide policy). Omit to hide it (e.g. no policy loaded).
  chatDeletion?: ChatDeletionControls;
}) {
  const rows = appAccessRows();
  const locked = new Set(lockedKeys);
  const summary = appAccessSummary(selected);
  const deleteRight = chatDeleteRight(selected);

  const setLevel = (row: AppAccessRow, level: AppAccessLevel) => onChange(setAppAccessLevel(selected, row, level));
  const setEnabled = (row: AppAccessRow, enabled: boolean) => onChange(toggleAppEnabled(selected, row, enabled));
  const setDeleteRight = (right: ChatDeleteRight) => onChange(setChatDeleteRight(selected, right));

  return (
    <fieldset style={cardStyle} data-testid={`${idPrefix}-app-access-section`}>
      <legend style={{ width: "100%" }}>
        <span style={legendRowStyle}>
          <span style={groupTitleStyle}>アプリのアクセス権</span>
          <span style={countStyle} data-testid={`${idPrefix}-app-access-count`}>
            {summary.enabled} / {summary.total} 有効
          </span>
        </span>
      </legend>
      <p style={groupHintStyle}>
        アプリごとに「有効化」で使える/使えないを切り替えます。有効にすると、そのロールに「閲覧まで」か「編集・作成まで」を選べます。
      </p>
      <div style={gridStyle} data-testid={`${idPrefix}-app-access-grid`}>
        {rows.map((row) => {
          const level = appAccessLevel(selected, row);
          const enabled = level !== "off";
          const isLocked = locked.has(row.view) || locked.has(row.edit);
          const badge = levelBadge(level);
          return (
            <div key={row.id} style={{ ...rowBaseStyle, ...(enabled ? rowOnStyle : null) }} data-testid={`${idPrefix}-app-${row.id}`}>
              <div style={rowHeadStyle}>
                <div style={switchWrapStyle}>
                  <Switch
                    id={`${idPrefix}-appsw-${row.id}`}
                    checked={enabled}
                    disabled={disabled || isLocked}
                    onChange={(next) => setEnabled(row, next)}
                    testId={`${idPrefix}-app-enable-${row.id}`}
                    label={
                      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                          <span style={nameStyle}>{row.label}</span>
                          <span style={keyHintStyle}>{row.id}</span>
                          {isLocked ? <span style={{ ...openHintStyle, fontWeight: 600 }}>🔒 固定</span> : null}
                        </span>
                        {row.openToAll ? <span style={openHintStyle}>ログイン中の全員に公開（無効化で運営限定にできます）</span> : null}
                      </span>
                    }
                  />
                </div>
                <span style={badgeWrapStyle}>
                  <Badge tone={badge.tone} testId={`${idPrefix}-app-state-${row.id}`}>
                    {badge.text}
                  </Badge>
                </span>
              </div>
              {enabled ? (
                <div style={nestStyle} data-testid={`${idPrefix}-app-level-${row.id}`}>
                  <span style={nestLabelStyle}>許可する範囲</span>
                  <SegmentedControl<AppAccessLevel>
                    size="sm"
                    aria-label={`${row.label} の許可範囲`}
                    value={level}
                    onChange={(next) => setLevel(row, next)}
                    options={LEVEL_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                      disabled: disabled || isLocked,
                      testId: `${idPrefix}-app-level-${row.id}-${o.value}`,
                    }))}
                    testId={`${idPrefix}-app-level-seg-${row.id}`}
                  />
                  {row.id === "chat" ? (
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }} data-testid={`${idPrefix}-chatdel`}>
                      <span style={nestLabelStyle}>削除権限</span>
                      <SegmentedControl<ChatDeleteRight>
                        size="sm"
                        aria-label="チャットの削除権限"
                        value={deleteRight}
                        onChange={(next) => setDeleteRight(next)}
                        options={DELETE_RIGHT_OPTIONS.map((o): SegmentedOption<ChatDeleteRight> => ({
                          value: o.value,
                          label: o.label,
                          disabled,
                          testId: `${idPrefix}-chatdel-right-${o.value}`,
                        }))}
                        testId={`${idPrefix}-chatdel-right`}
                      />
                      {/* 削除時の挙動 = org-wide policy (tier-bound). Only meaningful once the
                          role can delete something; hidden for 削除権限なし. */}
                      {chatDeletion && deleteRight !== "none" ? (
                        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={nestLabelStyle}>
                            削除時の挙動
                            <span style={{ marginLeft: 6, opacity: 0.8 }}>（ワークスペース共通）</span>
                          </span>
                          <SegmentedControl<chat.MessageDeletionMode>
                            size="sm"
                            aria-label="削除時の挙動"
                            value={chatDeletion.behavior}
                            onChange={(next) => chatDeletion.onBehaviorChange(next)}
                            options={DELETE_MODE_OPTIONS.map((o): SegmentedOption<chat.MessageDeletionMode> => ({
                              value: o.value,
                              label: o.label,
                              disabled: disabled || chatDeletion.behaviorDisabled,
                              testId: `${idPrefix}-chatdel-mode-${o.value}`,
                            }))}
                            testId={`${idPrefix}-chatdel-mode`}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
