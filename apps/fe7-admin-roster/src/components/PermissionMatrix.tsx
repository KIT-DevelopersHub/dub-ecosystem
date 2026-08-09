import type { identity } from "@dub/types";
import { groupByDomain, toggleDomain, togglePermission, domainSelectionState, type CatalogEntry } from "../lib/permissionMatrix";

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #d0d7de)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};
const rowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center" };
const dangerousStyle: React.CSSProperties = { color: "var(--dub-color-danger-600)" };

export function PermissionMatrix({
  catalog,
  selected,
  disabled,
  onChange,
}: {
  catalog: readonly CatalogEntry[];
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
}) {
  const groups = groupByDomain(catalog);

  return (
    <div data-testid="fe7-permission-matrix">
      {groups.map((g) => {
        const state = domainSelectionState(selected, g.entries);
        return (
          <fieldset key={g.domain} style={cardStyle}>
            <legend>
              <label style={rowStyle}>
                <input
                  type="checkbox"
                  checked={state.all}
                  ref={(el) => { if (el) el.indeterminate = state.some && !state.all; }}
                  disabled={disabled}
                  onChange={(e) => onChange(toggleDomain(selected, g.entries, e.target.checked))}
                  data-testid={`fe7-matrix-domain-${g.domain}`}
                />
                <strong>{g.domain}</strong>
              </label>
            </legend>
            {g.entries.map((e) => {
              const key = e.key as identity.PermissionKey;
              const checked = selected.includes(key);
              return (
                <label key={e.key} style={rowStyle}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onChange(togglePermission(selected, key))}
                    data-testid={`fe7-matrix-key-${e.key}`}
                  />
                  <span style={e.dangerous ? dangerousStyle : undefined} title={e.description}>
                    {e.name}
                    {e.dangerous ? " ⚠" : ""}
                  </span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
