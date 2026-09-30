// Pure logic for the role permission editor: single-key toggling, the self-lockout guard
// and the PATCH diff. No React here so it is exhaustively unit-testable.
//
// The grouping / per-app folding helpers that used to live here (groupByDomain,
// toggleDomain, domainSelectionState) are gone: the policy layer (@dub/types `policy`)
// owns app ⇄ level ⇄ key derivation and the 詳細/その他 partition now, so the UI reads one
// shared source instead of a second copy in FE7.
import type { identity } from "@dub/types";
import { appRegistry } from "@dub/types";
import type { UpdateRoleRequest } from "../contracts/pending";

/** Selection helper: toggle a single key on/off, returning a new sorted set. */
export function togglePermission(
  selected: readonly identity.PermissionKey[],
  key: identity.PermissionKey,
): identity.PermissionKey[] {
  const set = new Set(selected);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return [...set].sort();
}

/**
 * Keys that must stay granted on a role and cannot be toggled off (self-lockout
 * guard). Today only the built-in admin role is protected: stripping identity:admin
 * from it would leave nobody able to manage roles/permissions, locking everyone out.
 */
export function lockedKeysForRole(role: { name: string; isSystem: boolean }): identity.PermissionKey[] {
  // The admin role also keeps the 管理 app's per-app access keys: opening the 管理 app is
  // gated on app:admin:view (route guard + launcher) and its WRITES are gated on
  // app:admin:edit (identity-roster requireAdminEdit), so dropping either would lock admins
  // out of the very screen that manages roles. Freeze both tiers ON.
  return role.isSystem && role.name === "admin"
    ? ["identity:admin", "app:admin:view", "app:admin:edit"]
    : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Build the PATCH body carrying ONLY changed fields (design §2-4 "差分のみ" and
 * test "差分のみ UpdateRoleRequest に載る"). Returns null when nothing changed.
 *
 * Both sides are first run through withRequiredAppDomainKeys so a per-app toggle is
 * saved as EFFECTIVE 実効権限: granting an app (app:<id>:view|edit) auto-bundles the
 * domain read key(s) that app needs (identity:read 等) — the fix for the 抜け where the
 * per-app toggle was front-end-only and the domain API still 403'd. Normalizing BOTH
 * sides means (a) a legacy under-normalized role is not spuriously reported dirty on
 * open, and (b) the domain key required by an app-grant cannot be toggled off while the
 * grant remains (it is a dependency of the grant). Adds READ keys only — never
 * domain write/admin — so this never escalates a role to org-admin.
 */
export function buildRoleUpdate(
  original: { name: string; permissions: readonly identity.PermissionKey[] },
  next: { name: string; permissions: readonly identity.PermissionKey[] },
): UpdateRoleRequest | null {
  const patch: UpdateRoleRequest = {};
  if (next.name !== original.name) patch.name = next.name;
  const originalPerms = appRegistry.withRequiredAppDomainKeys(original.permissions);
  const nextPerms = appRegistry.withRequiredAppDomainKeys(next.permissions);
  if (!sameSet(originalPerms, nextPerms)) {
    patch.permissions = nextPerms; // already sorted, domain-key-bundled
  }
  return Object.keys(patch).length === 0 ? null : patch;
}
