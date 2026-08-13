// Pure logic for the AppAccessMatrix (app on/off toggles over a role's permission
// bundle). No React here so it is exhaustively unit-testable (mirrors permissionMatrix.ts).
import type { identity } from "@dub/types";
import type { AppCatalogEntry } from "./appCatalog";

/** True when the role's permission set enables the app (holds ALL its gating perms).
 *  Apps with no gating permission are always enabled (常時利用可). */
export function appEnabled(
  selected: readonly identity.PermissionKey[],
  app: AppCatalogEntry,
): boolean {
  if (app.requiredPermissions.length === 0) return true;
  const set = new Set(selected);
  return app.requiredPermissions.every((p) => set.has(p));
}

/** True when the app can be toggled: it must have a gating permission, and turning it
 *  OFF must not require removing a locked key (self-lockout guard). */
export function appControllable(
  app: AppCatalogEntry,
  lockedKeys: readonly identity.PermissionKey[] = [],
): boolean {
  if (app.requiredPermissions.length === 0) return false;
  const locked = new Set(lockedKeys);
  // If every gating key is locked, the app is effectively pinned on.
  return app.requiredPermissions.some((p) => !locked.has(p));
}

/**
 * Turn an app on/off by adding/removing its gating permissions, returning a new
 * sorted permission set. Locked keys are never removed (self-lockout guard).
 */
export function toggleApp(
  selected: readonly identity.PermissionKey[],
  app: AppCatalogEntry,
  enable: boolean,
  lockedKeys: readonly identity.PermissionKey[] = [],
): identity.PermissionKey[] {
  if (app.requiredPermissions.length === 0) return [...selected].sort();
  const set = new Set(selected);
  const locked = new Set(lockedKeys);
  for (const p of app.requiredPermissions) {
    if (enable) set.add(p);
    else if (!locked.has(p)) set.delete(p);
  }
  return [...set].sort();
}
