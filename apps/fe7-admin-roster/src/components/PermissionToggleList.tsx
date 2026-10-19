// 細かい権限（カタログキー）の ON/OFF 一覧。アプリの詳細ダイアログと「その他」ダイアログの
// 両方がこれを使うので、権限 1 件の見せ方（ラベル・生キー・注意バッジ・説明）は 1 実装だけ。
import type { identity } from "@dub/types";
import { Badge, Switch } from "@dub/ui";
import { permissionLabel, permissionDescription } from "../lib/permissionLabels";
import { togglePermission } from "../lib/permissionMatrix";

export const toggleListStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)" };
const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "var(--dub-space-3, 12px)",
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 6px)",
};
const rowOnStyle: React.CSSProperties = {
  background: "var(--dub-color-success-50, #ecfdf3)",
  borderColor: "var(--dub-color-success-200, #abefc6)",
};
const keyStyle: React.CSSProperties = {
  color: "var(--dub-color-text-muted, #6f7a90)",
  fontSize: 11,
  fontFamily: "var(--dub-font-family-mono, monospace)",
};
const descStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12, lineHeight: 1.55, marginLeft: 46 };
const labelStyle: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" };
const dangerStyle: React.CSSProperties = { marginLeft: 46 };

export function PermissionToggleList({
  entries,
  selected,
  disabled,
  onChange,
  lockedKeys = [],
  testIdPrefix,
}: {
  entries: readonly identity.PermissionCatalogEntry[];
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  /** 締め出し防止で外せないキー（admin ロールの identity:admin 等）. */
  lockedKeys?: readonly identity.PermissionKey[];
  /** testid 名前空間。トグルは `<prefix>-toggle-<key>`, 行は `<prefix>-row-<key>`. */
  testIdPrefix: string;
}) {
  const locked = new Set(lockedKeys);

  return (
    <div style={toggleListStyle}>
      {entries.map((entry) => {
        const key = entry.key as identity.PermissionKey;
        const keyLocked = locked.has(key);
        return (
          <ToggleRow
            key={key}
            id={`${testIdPrefix}-${key}`}
            testIdPrefix={testIdPrefix}
            testIdKey={key}
            checked={selected.includes(key)}
            disabled={disabled || keyLocked}
            onChange={() => onChange(togglePermission(selected, key))}
            title={permissionLabel(key, entry.name)}
            meta={
              <>
                <span style={keyStyle}>{key}</span>
                {keyLocked ? <Badge tone="neutral">固定</Badge> : null}
              </>
            }
            description={permissionDescription(key, entry.description)}
          >
            {entry.dangerous ? (
              <span style={dangerStyle}>
                <Badge tone="warning" testId={`${testIdPrefix}-danger-${key}`}>
                  取り扱い注意
                </Badge>
              </span>
            ) : null}
          </ToggleRow>
        );
      })}
    </div>
  );
}

/** ON/OFF 1 行。権限キー以外の設定（メールの別ロール閲覧）も同じ見た目にするため共有する. */
export function ToggleRow({
  id,
  testIdPrefix,
  testIdKey,
  checked,
  disabled,
  onChange,
  title,
  meta,
  description,
  children,
}: {
  id: string;
  testIdPrefix: string;
  testIdKey: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title: React.ReactNode;
  meta?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ ...rowStyle, ...(checked ? rowOnStyle : null) }} data-testid={`${testIdPrefix}-row-${testIdKey}`}>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        testId={`${testIdPrefix}-toggle-${testIdKey}`}
        label={
          <span style={labelStyle}>
            <span style={{ fontWeight: 600 }}>{title}</span>
            {meta}
          </span>
        }
      />
      {description ? <p style={descStyle}>{description}</p> : null}
      {children}
    </div>
  );
}
