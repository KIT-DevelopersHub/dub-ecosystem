// ScopePicker logic (design §2-3, test "ScopePicker"). org-wide vs event scope.
import type { identity, common } from "@dub/types";
import type { AssignRoleRequest } from "../contracts/pending";

export type ScopeKind = "org" | "event";

export interface ScopeSelection {
  kind: ScopeKind;
  eventId: common.EventId | null;
}

export const DEFAULT_SCOPE: ScopeSelection = { kind: "org", eventId: null };

/**
 * Build AssignRoleRequest. For org-wide the resource fields are OMITTED (undefined),
 * never set to null (contract test). For event scope both fields are present.
 */
export function buildAssignRequest(
  roleId: common.RoleId,
  scope: ScopeSelection,
): AssignRoleRequest {
  if (scope.kind === "event" && scope.eventId) {
    return { roleId, resourceType: "event", resourceId: scope.eventId };
  }
  return { roleId }; // org-wide: no resourceType/resourceId keys
}

/**
 * Whether the event-scope option may be offered. Requires `event:read` to fetch
 * candidates; without it FE7 degrades to org-wide only (design §6 FORBIDDEN row).
 */
export function eventScopeAvailable(
  permissions: readonly identity.PermissionKey[] | null | undefined,
): boolean {
  return !!permissions && permissions.includes("event:read");
}
