// Display-side authorization gating. The server (authz/check) is the true
// authority; FE4 only reflects `effectivePermissions` (from GET /api/v1/me) to
// enable/disable UI (design §6). fail-closed while permissions are unloaded.
import type { identity } from "@dub/types";

type PermissionKey = identity.PermissionKey;

export interface TaskCapabilities {
  canRead: boolean;
  canWrite: boolean; // create / edit / D&D / dependency edit
  canDelete: boolean;
}

/** `perms === null` == not yet loaded -> everything denied (fail-closed). */
export function taskCapabilities(perms: readonly PermissionKey[] | null): TaskCapabilities {
  if (perms === null) return { canRead: false, canWrite: false, canDelete: false };
  const has = (k: PermissionKey): boolean => perms.includes(k);
  return {
    canRead: has("task:read"),
    canWrite: has("task:write"),
    canDelete: has("task:delete"),
  };
}
