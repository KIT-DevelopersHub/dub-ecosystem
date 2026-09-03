import type { identity } from "@dub/types";
import { Badge, Switch } from "@dub/ui";
import { groupByDomain, toggleDomain, togglePermission, domainSelectionState, type CatalogEntry } from "../lib/permissionMatrix";
import { domainLabel, permissionLabel, permissionDescription } from "../lib/permissionLabels";
import { AppAccessSection } from "./AppAccessSection";

// Design-system tokens (@dub/tokens) with literal fallbacks so the matrix still
// reads correctly if a token is ever absent. Each permission is an on/off toggle
// (@dub/ui Switch) with an always-visible plain-Japanese description underneath, so
// even non-obvious keys explain what turning them on grants. Enabled rows get a
// success tint so on/off is legible at a glance, not only from the toggle.
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default)",
  borderRadius: "var(--dub-radius-md)",
  padding: "var(--dub-space-3)",
  marginBottom: "var(--dub-space-3)",
  background: "var(--dub-color-surface-base)",
};
const legendRowStyle: React.CSSProperties = { display: "flex", gap: "var(--dub-space-2)", alignItems: "center", width: "100%" };
const groupTitleStyle: React.CSSProperties = { fontWeight: 700, fontSize: 15 };
const countStyle: React.CSSProperties = { marginLeft: "auto", color: "var(--dub-color-text-muted)", fontSize: 13 };
// Two-column grid for the permission rows: halves the vertical scroll length vs the
// old single full-width column. The min track width (460px) is wide enough that only
// two columns fit a normal admin panel, so it stays a true 2-column layout instead of
// packing 3–4 columns on wide screens; `min(100%, …)` lets it collapse to a single
// full-width column on a narrow (mobile) viewport without overflowing.
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))",
  gap: "var(--dub-space-1)",
};
const rowBaseStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "8px 8px",
  borderRadius: 6,
};
const rowOnStyle: React.CSSProperties = { background: "var(--dub-color-surface-sunken)" };
const switchWrapStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
const labelBlockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const labelLineStyle: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" };
const nameStyle: React.CSSProperties = { fontWeight: 600, fontSize: "var(--dub-font-size-sm)" };
const dangerousNameStyle: React.CSSProperties = { ...nameStyle, color: "var(--dub-color-danger-600)" };
const descStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", fontSize: 12.5, lineHeight: 1.45 };
const keyHintStyle: React.CSSProperties = {
  color: "var(--dub-color-text-muted)",
  fontSize: 11,
  fontFamily: "var(--dub-font-family-mono, monospace)",
};
const lockHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted)", fontSize: 11, fontWeight: 600 };
const badgeWrapStyle: React.CSSProperties = { flex: "none", paddingTop: 1 };

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
  // Keys that stay on and cannot be toggled off even when the rest of the matrix is
  // editable — e.g. identity:admin on the admin role (self-lockout guard).
  lockedKeys?: readonly identity.PermissionKey[];
}) {
  const groups = groupByDomain(catalog);
  const locked = new Set(lockedKeys);

  return (
    <div data-testid={`${idPrefix}-permission-matrix`}>
      {groups.map((g) => {
        // The per-app access tier (domain "app") renders as a 2-tier accordion (有効化
        // トグル → ネストした 閲覧/編集作成 セレクタ) instead of the flat per-key grid, so every
        // app gets one clean on/off row. All other domains keep the standard grid.
        if (g.domain === "app") {
          return (
            <AppAccessSection
              key={g.domain}
              selected={selected}
              disabled={disabled}
              onChange={onChange}
              idPrefix={idPrefix}
              lockedKeys={lockedKeys}
            />
          );
        }
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
            <div style={gridStyle} data-testid={`${idPrefix}-matrix-grid-${g.domain}`}>
            {g.entries.map((e) => {
              const key = e.key as identity.PermissionKey;
              const checked = selected.includes(key);
              const isLocked = locked.has(key);
              const description = permissionDescription(e.key, e.description);
              return (
                <div key={e.key} style={{ ...rowBaseStyle, ...(checked ? rowOnStyle : null) }}>
                  <div style={switchWrapStyle}>
                    <Switch
                      id={`${idPrefix}-sw-${e.key}`}
                      checked={checked}
                      disabled={disabled || isLocked}
                      onChange={() => onChange(togglePermission(selected, key))}
                      testId={`${idPrefix}-matrix-key-${e.key}`}
                      label={
                        <span style={labelBlockStyle}>
                          <span style={labelLineStyle}>
                            <span style={e.dangerous ? dangerousNameStyle : nameStyle}>
                              {permissionLabel(e.key, e.name)}
                              {e.dangerous ? " ⚠" : ""}
                            </span>
                            <span style={keyHintStyle}>{e.key}</span>
                            {isLocked ? <span style={lockHintStyle}>🔒 固定</span> : null}
                          </span>
                          <span style={descStyle} data-testid={`${idPrefix}-matrix-desc-${e.key}`}>
                            {description}
                            {isLocked ? "（締め出し防止のため外せません）" : ""}
                          </span>
                        </span>
                      }
                    />
                  </div>
                  <span style={badgeWrapStyle}>
                    <Badge tone={checked ? "success" : "neutral"} testId={`${idPrefix}-matrix-state-${e.key}`}>
                      {checked ? "オン" : "オフ"}
                    </Badge>
                  </span>
                </div>
              );
            })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
