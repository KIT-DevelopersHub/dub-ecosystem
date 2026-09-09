import { useState } from "react";
import type { identity } from "@dub/types";
import { Badge, Button, SegmentedControl, Switch } from "@dub/ui";
import {
  appAccessRows,
  appAccessLevel,
  appAccessSummary,
  allRowKeys,
  availableLevels,
  setAppAccessLevel,
  toggleAppEnabled,
  type AppAccessLevel,
  type AppAccessRow,
  type LabeledKey,
} from "../lib/appAccessMatrix";
import { togglePermission, type CatalogEntry } from "../lib/permissionMatrix";

// PER-APP tier of the role matrix (catalog domain "app" + each app's own domain
// capabilities). Instead of one "有効化" toggle for JUST app:<id>:view/edit and a
// separate flat grid of that app's other permission keys elsewhere on the screen, this
// folds BOTH into one 2段階 control per app: 有効化 Switch → when ON, a LEVEL selector
// (閲覧まで / 編集・作成まで / 管理まで — 管理 only offered when the app actually has a
// manage-tier key) that maps to turning the right key GROUP on/off (lib/appAccessMatrix).
// Turning an app OFF hides/greys everything below it, including the 詳細 (individual-key)
// escape hatch, so an admin never has to reason about keys for an app the role can't open.
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
const sharedHintStyle: React.CSSProperties = { color: "var(--dub-color-warning-700, #b54708)", fontSize: 11 };
const badgeWrapStyle: React.CSSProperties = { flex: "none" };
// Nested (indented) level selector — visually reads as a child of the enable toggle.
const nestStyle: React.CSSProperties = {
  marginLeft: 46,
  paddingLeft: 12,
  borderLeft: "2px solid var(--dub-color-border-default, #dde1e9)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const nestLabelStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12 };
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))",
  gap: 4,
};
const detailListStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 };
const detailRowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start" };
const detailLabelStyle: React.CSSProperties = { fontWeight: 600, fontSize: 12.5 };
const detailDescStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11.5 };

const LEVEL_LABELS: Record<Exclude<AppAccessLevel, "off">, string> = {
  view: "閲覧まで",
  edit: "編集・作成まで",
  manage: "管理まで",
};

function levelBadge(level: AppAccessLevel): { tone: "success" | "neutral"; text: string } {
  if (level === "off") return { tone: "neutral", text: "無効" };
  if (level === "manage") return { tone: "success", text: "管理" };
  if (level === "edit") return { tone: "success", text: "編集・作成" };
  return { tone: "success", text: "閲覧" };
}

function DetailKeyRow({
  entry,
  checked,
  disabled,
  onToggle,
  testId,
}: {
  entry: LabeledKey;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <div style={detailRowStyle}>
      <Switch
        id={`${testId}-sw`}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        testId={testId}
        label={
          <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <span style={entry.dangerous ? { ...detailLabelStyle, color: "var(--dub-color-danger-600, #d92d20)" } : detailLabelStyle}>
                {entry.label}
                {entry.dangerous ? " ⚠" : ""}
              </span>
              <span style={keyHintStyle}>{entry.key}</span>
            </span>
            <span style={detailDescStyle}>{entry.description}</span>
          </span>
        }
      />
    </div>
  );
}

export function AppAccessSection({
  catalog,
  selected,
  disabled,
  onChange,
  idPrefix = "fe7",
  lockedKeys = [],
}: {
  catalog: readonly CatalogEntry[];
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  idPrefix?: string;
  // Keys that must stay granted (e.g. app:admin:view/edit + identity:admin on the admin
  // role) — the enable toggle + level selector are frozen ON to prevent self-lockout.
  lockedKeys?: readonly identity.PermissionKey[];
}) {
  const rows = appAccessRows(catalog);
  const locked = new Set(lockedKeys);
  const summary = appAccessSummary(selected, rows);
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());

  const setLevel = (row: AppAccessRow, level: AppAccessLevel) =>
    onChange(setAppAccessLevel(selected, row, level, lockedKeys));
  const setEnabled = (row: AppAccessRow, enabled: boolean) =>
    onChange(toggleAppEnabled(selected, row, enabled, lockedKeys));
  const toggleDetail = (id: string) =>
    setOpenDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
        アプリごとに「有効化」で使える/使えないを切り替えます。有効にすると「閲覧まで／編集・作成まで」（アプリによっては「管理まで」）を選べます。
        個別の権限を微調整したい場合は各アプリの「詳細」を開いてください。
      </p>
      <div style={gridStyle} data-testid={`${idPrefix}-app-access-grid`}>
        {rows.map((row) => {
          const level = appAccessLevel(selected, row);
          const enabled = level !== "off";
          const isLocked = allRowKeys(row).some((k) => locked.has(k));
          const badge = levelBadge(level);
          const levels = availableLevels(row).filter((l): l is Exclude<AppAccessLevel, "off"> => l !== "off");
          const hasDetails = row.viewKeys.length + row.editKeys.length + row.manageKeys.length > 0;
          const detailOpen = openDetails.has(row.id);
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
                        {row.sharedDomain ? (
                          <span style={sharedHintStyle}>
                            他アプリと機能領域を共有するため、このアプリは「開く／編集・作成」の2段階のみです。
                          </span>
                        ) : null}
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
                    options={levels.map((l) => ({
                      value: l,
                      label: LEVEL_LABELS[l],
                      disabled: disabled || isLocked,
                      testId: `${idPrefix}-app-level-${row.id}-${l}`,
                    }))}
                    testId={`${idPrefix}-app-level-seg-${row.id}`}
                  />
                  {hasDetails ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleDetail(row.id)}
                        testId={`${idPrefix}-app-details-toggle-${row.id}`}
                      >
                        {detailOpen ? "詳細を隠す" : "詳細を見る（個別の権限を調整）"}
                      </Button>
                      {detailOpen ? (
                        <div style={detailListStyle} data-testid={`${idPrefix}-app-details-${row.id}`}>
                          {[...row.viewKeys, ...row.editKeys, ...row.manageKeys].map((entry) => (
                            <DetailKeyRow
                              key={entry.key}
                              entry={entry}
                              checked={selected.includes(entry.key)}
                              disabled={Boolean(disabled) || locked.has(entry.key)}
                              onToggle={() => onChange(togglePermission(selected, entry.key))}
                              testId={`${idPrefix}-app-detail-${row.id}-${entry.key}`}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
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
