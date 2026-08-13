// App-access on/off grid for a single role. A coarse, human-readable view over the
// role's permission bundle: each row is an app (launcher tile); turning it on/off
// grants/removes that app's gating permission(s) (see lib/appCatalog + lib/appAccess).
// Edits the SAME `selected` permission array as PermissionMatrix, so one Save persists
// both. Turning an app OFF makes its launcher tile gray out for members of the role.
import type { identity } from "@dub/types";
import { Badge, Switch } from "@dub/ui";
import { APP_CATALOG, type AppCatalogEntry } from "../lib/appCatalog";
import { appControllable, appEnabled, toggleApp } from "../lib/appAccess";

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  background: "var(--dub-color-surface-base, #ffffff)",
};
const legendStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", width: "100%" };
const titleStyle: React.CSSProperties = { fontWeight: 700, fontSize: 15 };
const countStyle: React.CSSProperties = { marginLeft: "auto", color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 13 };
const rowBaseStyle: React.CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", padding: "8px", borderRadius: 6 };
const rowOnStyle: React.CSSProperties = { background: "var(--dub-color-success-50, #ecfdf3)" };
const switchWrapStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
const labelBlockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const nameStyle: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const descStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.45 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 11, fontWeight: 600 };
const badgeWrapStyle: React.CSSProperties = { flex: "none", paddingTop: 1 };

export function AppAccessMatrix({
  selected,
  disabled,
  onChange,
  idPrefix = "fe7",
  lockedKeys = [],
  apps = APP_CATALOG,
}: {
  selected: readonly identity.PermissionKey[];
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  idPrefix?: string;
  lockedKeys?: readonly identity.PermissionKey[];
  apps?: readonly AppCatalogEntry[];
}) {
  const onCount = apps.reduce((n, a) => n + (appEnabled(selected, a) ? 1 : 0), 0);

  return (
    <fieldset style={cardStyle} data-testid={`${idPrefix}-app-access`}>
      <legend style={{ width: "100%" }}>
        <span style={legendStyle}>
          <span style={titleStyle}>アプリアクセス</span>
          <span style={countStyle} data-testid={`${idPrefix}-app-access-count`}>
            {onCount} / {apps.length} 利用可
          </span>
        </span>
      </legend>
      {apps.map((app) => {
        const enabled = appEnabled(selected, app);
        const controllable = !disabled && appControllable(app, lockedKeys);
        // Ungated apps (常時利用可) render on + locked so their intent is clear.
        return (
          <div key={app.id} style={{ ...rowBaseStyle, ...(enabled ? rowOnStyle : null) }}>
            <div style={switchWrapStyle}>
              <Switch
                id={`${idPrefix}-app-sw-${app.id}`}
                checked={enabled}
                disabled={!controllable}
                onChange={(next) => onChange(toggleApp(selected, app, next, lockedKeys))}
                testId={`${idPrefix}-app-toggle-${app.id}`}
                label={
                  <span style={labelBlockStyle}>
                    <span style={nameStyle}>{app.label}</span>
                    <span style={descStyle}>
                      {app.description}
                      {app.requiredPermissions.length === 0 ? "（常時利用可・権限制御なし）" : ""}
                    </span>
                    {app.requiredPermissions.length === 0 ? <span style={hintStyle}>🔒 常時利用可</span> : null}
                  </span>
                }
              />
            </div>
            <span style={badgeWrapStyle}>
              <Badge tone={enabled ? "success" : "neutral"} testId={`${idPrefix}-app-state-${app.id}`}>
                {enabled ? "オン" : "オフ"}
              </Badge>
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}
