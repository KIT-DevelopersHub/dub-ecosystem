// 細かい権限（カタログキー）の ON/OFF 一覧。アプリの詳細ダイアログと「その他」ダイアログの
// 両方がこれを使うので、権限 1 件の見せ方（ラベル・生キー・注意バッジ・説明）は 1 実装だけ。
import type { identity } from "@dub/types";
import { Badge, Switch } from "@dub/ui";
import { permissionLabel, permissionDescription } from "../lib/permissionLabels";
import { togglePermission } from "../lib/permissionMatrix";

const listStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)" };
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
    <div style={listStyle}>
      {entries.map((entry) => {
        const key = entry.key as identity.PermissionKey;
        const on = selected.includes(key);
        const keyLocked = locked.has(key);
        return (
          <div key={key} style={{ ...rowStyle, ...(on ? rowOnStyle : null) }} data-testid={`${testIdPrefix}-row-${key}`}>
            <Switch
              id={`${testIdPrefix}-${key}`}
              checked={on}
              disabled={disabled || keyLocked}
              onChange={() => onChange(togglePermission(selected, key))}
              testId={`${testIdPrefix}-toggle-${key}`}
              label={
                <span style={labelStyle}>
                  <span style={{ fontWeight: 600 }}>{permissionLabel(key, entry.name)}</span>
                  <span style={keyStyle}>{key}</span>
                  {keyLocked ? <Badge tone="neutral">固定</Badge> : null}
                </span>
              }
            />
            <p style={descStyle}>{permissionDescription(key, entry.description)}</p>
            {entry.dangerous ? (
              <span style={dangerStyle}>
                <Badge tone="warning" testId={`${testIdPrefix}-danger-${key}`}>
                  取り扱い注意
                </Badge>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
