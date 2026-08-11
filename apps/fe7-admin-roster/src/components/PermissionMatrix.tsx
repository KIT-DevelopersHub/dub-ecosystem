import type { identity } from "@dub/types";
import { Badge } from "@dub/ui";
import { groupByDomain, toggleDomain, togglePermission, domainSelectionState, type CatalogEntry } from "../lib/permissionMatrix";
import { domainLabel, permissionLabel, permissionDescription } from "../lib/permissionLabels";

// Design-system tokens (@dub/tokens) with literal fallbacks so the matrix still
// reads correctly if a token is ever absent. Enabled rows get a success tint so
// on/off is legible at a glance, not only from the checkbox.
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  background: "var(--dub-color-surface-base, #ffffff)",
};
const legendRowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", width: "100%" };
const groupTitleStyle: React.CSSProperties = { fontWeight: 700, fontSize: 15 };
const countStyle: React.CSSProperties = { marginLeft: "auto", color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 13 };
const rowBaseStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "6px 8px",
  borderRadius: 6,
};
const rowOnStyle: React.CSSProperties = { background: "var(--dub-color-success-50, #ecfdf3)" };
const labelTextStyle: React.CSSProperties = { flex: 1 };
const dangerousStyle: React.CSSProperties = { color: "var(--dub-color-danger-600, #d92d20)" };
const keyHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12, marginLeft: 6 };

export function PermissionMatrix({
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
  // testid namespace. Default "fe7" (single matrix per screen). Inline editors on the
  // role list pass a per-role prefix so multiple matrices never collide on the page.
  idPrefix?: string;
  // Keys that stay checked and cannot be toggled off even when the rest of the matrix
  // is editable — e.g. identity:admin on the admin role (self-lockout guard).
  lockedKeys?: readonly identity.PermissionKey[];
}) {
  const groups = groupByDomain(catalog);
  const locked = new Set(lockedKeys);

  return (
    <div data-testid={`${idPrefix}-permission-matrix`}>
      {groups.map((g) => {
        const state = domainSelectionState(selected, g.entries);
        const onCount = g.entries.reduce((n, e) => n + (selected.includes(e.key as identity.PermissionKey) ? 1 : 0), 0);
        return (
          <fieldset key={g.domain} style={cardStyle}>
            <legend style={{ width: "100%" }}>
              <span style={legendRowStyle}>
                <input
                  type="checkbox"
                  aria-label={`${domainLabel(g.domain)}をすべて切り替え`}
                  checked={state.all}
                  ref={(el) => { if (el) el.indeterminate = state.some && !state.all; }}
                  disabled={disabled}
                  onChange={(e) => onChange(toggleDomain(selected, g.entries, e.target.checked, lockedKeys))}
                  data-testid={`${idPrefix}-matrix-domain-${g.domain}`}
                />
                <span style={groupTitleStyle}>{domainLabel(g.domain)}</span>
                <span style={countStyle} data-testid={`${idPrefix}-matrix-count-${g.domain}`}>
                  {onCount} / {g.entries.length} 有効
                </span>
              </span>
            </legend>
            {g.entries.map((e) => {
              const key = e.key as identity.PermissionKey;
              const checked = selected.includes(key);
              return (
                <label key={e.key} style={{ ...rowBaseStyle, ...(checked ? rowOnStyle : null) }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || locked.has(key)}
                    onChange={() => onChange(togglePermission(selected, key))}
                    data-testid={`${idPrefix}-matrix-key-${e.key}`}
                  />
                  <span style={labelTextStyle}>
                    <span style={e.dangerous ? dangerousStyle : undefined} title={permissionDescription(e.key, e.description)}>
                      {permissionLabel(e.key, e.name)}
                      {e.dangerous ? " ⚠" : ""}
                    </span>
                    <span style={keyHintStyle}>{e.key}</span>
                  </span>
                  <Badge tone={checked ? "success" : "neutral"} testId={`${idPrefix}-matrix-state-${e.key}`}>
                    {checked ? "オン" : "オフ"}
                  </Badge>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
