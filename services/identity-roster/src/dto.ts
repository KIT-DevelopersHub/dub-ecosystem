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

export interface InviteUserResponse {
  user: identity.IdentityUser; // status = "invited"
}

export type ProvisionStatus = "existing" | "provisioned" | "rejected";
export interface ProvisionUserResponse {
  status: ProvisionStatus; // rejected = not on the invite roster (auth maps to 403)
  user: identity.IdentityUser | null; // null when rejected (no row created)
}

export interface AssignRoleResult {
  assignmentId: string;
}

export interface EffectivePermissionsResponse {
  userId: common.UserId;
  orgId: common.OrgId;
  permissions: identity.PermissionKey[]; // org-wide only
}
