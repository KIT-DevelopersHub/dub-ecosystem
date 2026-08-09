// Permission judgement helper. UX-only gating (design §6: server enforces).
// Fail-closed: while `me` is loading (permissions === null) every check denies.
import type { identity } from "@dub/types";

/** Core predicate used by usePermissions().can — deny when permissions unknown. */
export function canWith(
  permissions: readonly identity.PermissionKey[] | null | undefined,
  required: identity.PermissionKey,
): boolean {
  if (!permissions) return false; // fail-closed
  return permissions.includes(required);
}

/**
 * AND across a list (route guard: all requiredPermissions must hold).
 * Fail-closed while loading: null permissions deny even an empty requirement.
 * Once loaded, an empty requirement means "any authenticated user" -> allow.
 */
export function canAll(
  permissions: readonly identity.PermissionKey[] | null | undefined,
  required: readonly identity.PermissionKey[],
): boolean {
  if (!permissions) return false; // fail-closed (loading / unauthenticated)
  return required.every((p) => permissions.includes(p));
}
