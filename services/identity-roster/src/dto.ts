// Service-internal request/response shapes NOT carried by the frozen @dub/types
// identity namespace (management endpoints + provision response). Public read
// models (IdentityUser, Role, AuthzCheckResponse, ...) always come from @dub/types.
import type { common, identity } from "@dub/types";

export interface UpdateUserRequest {
  displayName?: string;
  githubLogin?: string | null;
  status?: identity.UserStatus; // "disabled"/"rejected" => sync session revoke
}

export interface CreateRoleRequest {
  name: string;
  permissions: identity.PermissionKey[];
}
export interface UpdateRoleRequest {
  name?: string;
  permissions?: identity.PermissionKey[];
}
export interface AssignRoleRequest {
  roleId: common.RoleId;
  resourceType?: string; // P0: "event"
  resourceId?: string;
}

// Role viewed WITH its live member count (org-scoped, distinct users holding the
// role at any scope). Superset of the frozen identity.Role — FE7's RoleListPage
// types identity.Role and ignores the extra field; the RBAC admin console reads
// memberCount. Added here (not in @dub/types) so the frozen contract stays frozen.
export type RoleWithMemberCount = identity.Role & { memberCount: number };

// Assignment as the FE renders it (fe7 contracts/pending RoleAssignment): the raw
// AssignmentRow plus the denormalized roleName. This is the wire shape returned by
// POST /users/:id/roles and GET /users/:id/roles so the front-end never has to
// re-join role names client-side.
export interface RoleAssignmentView {
  id: string; // assignment id
  userId: common.UserId;
  roleId: common.RoleId;
  roleName: string;
  resourceType: string | null; // null = org-wide
  resourceId: string | null;
  grantedBy: common.UserId;
  grantedAt: common.ISODateTime;
}

export interface InviteUserResponse {
  user: identity.IdentityUser; // status = "invited"
}

export type ProvisionStatus = "existing" | "provisioned" | "rejected";
export interface ProvisionUserResponse {
  status: ProvisionStatus; // rejected = not on the invite roster (auth maps to 403)
  user: identity.IdentityUser | null; // null when rejected (no row created)
}


export interface EffectivePermissionsResponse {
  userId: common.UserId;
  orgId: common.OrgId;
  permissions: identity.PermissionKey[]; // org-wide only
}
