// Local, PENDING identity contract shapes referenced by the FE7 design (§2-4/§2-5)
// but not yet present in the frozen `@dub/types` identity namespace at this cut:
//   CreateRoleRequest, UpdateRoleRequest, AssignRoleRequest, RoleAssignment.
//
// They are modelled here so FE7 can build request/response bodies type-safely
// today. When identity-roster lands these in @dub/types they replace this file
// (import from "@dub/types" identity namespace). Kept minimal and P0-scoped
// (resourceType "event" only; task-scope is P1 per design #5).
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
