// Local, PENDING identity contract shapes referenced by the FE7 design (§2-4/§2-5)
// but not yet present in the frozen `@dub/types` identity namespace at this cut:
//   CreateRoleRequest, UpdateRoleRequest, AssignRoleRequest, RoleAssignment.
//
// Cross-PR contract source: these are OWNED by services/identity-roster, which is
// on a separate, still-unmerged branch and is OFF-LIMITS to this PR. FE7 therefore
// models them LOCALLY here (do NOT import from services/identity-roster, and do not
// take a build dependency on it). When identity-roster merges and publishes these
// into the `@dub/types` identity namespace, delete this file and import from there.
//
// Kept minimal and P0-scoped (resourceType "event" only; task-scope is P1 per
// design #5).
import type { identity, common } from "@dub/types";

export interface CreateRoleRequest {
  name: string;
  permissions: identity.PermissionKey[];
}

// PATCH sends only the changed fields (design §2-4 "差分のみ").
export interface UpdateRoleRequest {
  name?: string;
  permissions?: identity.PermissionKey[];
}

// P0: org-wide (no resource fields) or event-scoped. Fields are OMITTED, not null,
// for org-wide (design test "ScopePicker": undefined, not null).
export interface AssignRoleRequest {
  roleId: common.RoleId;
  resourceType?: "event";
  resourceId?: common.EventId;
}

export interface RoleAssignment {
  id: string; // assignment id
  userId: common.UserId;
  roleId: common.RoleId;
  roleName: string;
  resourceType: "event" | null; // null = org-wide
  resourceId: string | null;
  grantedBy: common.UserId;
  grantedAt: common.ISODateTime;
}
