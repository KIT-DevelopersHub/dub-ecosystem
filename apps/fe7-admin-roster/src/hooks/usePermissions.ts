// Thin wrapper over FE2's can(permission). Sources org-wide effective permissions
// from MeResponse.permissions (frozen gateway.MeResponse). Fail-closed while me
// is null (design §7 usePermissions test).
import { useCallback } from "react";
import type { identity } from "@dub/types";
import { useRosterContext } from "../providers/RosterProvider";
import { canWith, canAll } from "../lib/permissions";

export interface UsePermissions {
  can: (permission: identity.PermissionKey) => boolean;
  canAll: (permissions: readonly identity.PermissionKey[]) => boolean;
  ready: boolean; // false while me is loading
}

export function usePermissions(): UsePermissions {
  const { me } = useRosterContext();
  const permissions = me?.permissions ?? null;
  const can = useCallback((p: identity.PermissionKey) => canWith(permissions, p), [permissions]);
  const all = useCallback((ps: readonly identity.PermissionKey[]) => canAll(permissions, ps), [permissions]);
  return { can, canAll: all, ready: me !== null };
}
