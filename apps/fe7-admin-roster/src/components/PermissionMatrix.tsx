import { useState } from "react";
import type { identity } from "@dub/types";
import { Badge, Icon, Switch } from "@dub/ui";
import { groupByDomain, toggleDomain, togglePermission, domainSelectionState, type CatalogEntry } from "../lib/permissionMatrix";
import { domainLabel, permissionLabel, permissionDescription } from "../lib/permissionLabels";
import { AppAccessSection } from "./AppAccessSection";
import { AccordionPanel } from "./AccordionPanel";

// Design-system tokens (@dub/tokens) with literal fallbacks so the matrix still
// reads correctly if a token is ever absent. Each permission is an on/off toggle
// (@dub/ui Switch) with an always-visible plain-Japanese description underneath, so
// even non-obvious keys explain what turning them on grants. Enabled rows get a
// success tint so on/off is legible at a glance, not only from the toggle.
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
// Collapse toggle: a plain button (not the "select all" checkbox beside it) so the
// two controls never fight over the same click. Each domain group opens/closes
// independently (P26) — long role matrices (many domains) stay scannable because
// the reader can fold away groups they aren't touching right now.
const toggleButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  textAlign: "left",
  color: "inherit",
};
const chevronStyle: React.CSSProperties = {
  transition: "transform var(--dub-motion-fast, 120ms) var(--dub-motion-easing, cubic-bezier(0.4, 0, 0.2, 1))",
};
// Two-column grid for the permission rows: halves the vertical scroll length vs the
// old single full-width column. The min track width (460px) is wide enough that only
// two columns fit a normal admin panel, so it stays a true 2-column layout instead of
// packing 3–4 columns on wide screens; `min(100%, …)` lets it collapse to a single
// full-width column on a narrow (mobile) viewport without overflowing.
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))",
  gap: 4,
};
const rowBaseStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "8px 8px",
  borderRadius: 6,
};
const rowOnStyle: React.CSSProperties = { background: "var(--dub-color-success-50, #ecfdf3)" };
const switchWrapStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
const labelBlockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const labelLineStyle: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" };
const nameStyle: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const dangerousNameStyle: React.CSSProperties = { ...nameStyle, color: "var(--dub-color-danger-600, #d92d20)" };
const descStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.45 };
const keyHintStyle: React.CSSProperties = {
  color: "var(--dub-color-text-muted, #6f7a90)",
  fontSize: 11,
  fontFamily: "var(--dub-font-family-mono, monospace)",
};
const lockHintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11, fontWeight: 600 };
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
  // Every domain group starts open (unchanged default behavior); collapsing is an
  // opt-in decluttering action, not something that hides data on first view.
  const [openDomains, setOpenDomains] = useState<Set<string>>(
    () => new Set(groups.filter((g) => g.domain !== "app").map((g) => g.domain)),
  );
  const toggleDomainOpen = (domain: string) =>
    setOpenDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });

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
        const isOpen = openDomains.has(g.domain);
        const panelId = `${idPrefix}-matrix-panel-${g.domain}`;
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
                <button
                  type="button"
                  style={toggleButtonStyle}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggleDomainOpen(g.domain)}
                  data-testid={`${idPrefix}-matrix-toggle-${g.domain}`}
                >
                  <span style={{ ...chevronStyle, display: "inline-flex", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}>
                    <Icon name="chevron-right" size="sm" />
                  </span>
                  <span style={groupTitleStyle}>{domainLabel(g.domain)}</span>
                </button>
                <span style={countStyle} data-testid={`${idPrefix}-matrix-count-${g.domain}`}>
                  {onCount} / {g.entries.length} 有効
                </span>
              </span>
            </legend>
            <AccordionPanel open={isOpen} id={panelId}>
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
            </AccordionPanel>
          </fieldset>
        );
      })}
    </div>
  );
}
