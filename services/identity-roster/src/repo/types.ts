// Repository boundary. Two implementations exist: D1IdentityRepo (production,
// namespace-scoped @dub/db) and MemIdentityRepo (tests + local dev). Route
// handlers depend only on this interface — the RBAC semantics live in authz.ts
// and are identical regardless of the backing store.
import type { identity } from "@dub/types";

export interface OrgRow {
  id: string;
  name: string;
  createdAt: string;
}

export interface UserRow {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  status: identity.UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RoleRow {
  id: string;
  orgId: string;
  name: string;
  isSystem: boolean;
  permissions: identity.PermissionKey[];
  createdAt: string;
  updatedAt: string;
}

// resourceType/resourceId null => org-wide grant. P0 resource scope: "event".
export interface AssignmentRow {
  id: string;
  userId: string;
  roleId: string;
  orgId: string;
  resourceType: string | null;
  resourceId: string | null;
  grantedBy: string;
  grantedAt: string;
}

export interface ListUsersFilter {
  orgId: string;
  ids?: string[];
  status?: identity.UserStatus;
  limit: number;
  cursor?: string;
}

export interface UserPage {
  items: UserRow[];
  nextCursor: string | null;
}

export interface IdentityRepo {
  // orgs
  getOrg(orgId: string): Promise<OrgRow | null>;
  createOrg(row: OrgRow): Promise<void>;
  listOrgs(limit: number, cursor?: string): Promise<{ items: OrgRow[]; nextCursor: string | null }>;

  // users
  getUser(userId: string): Promise<UserRow | null>;
  getUserByEmail(orgId: string, email: string): Promise<UserRow | null>;
  listUsers(filter: ListUsersFilter): Promise<UserPage>;
  createUser(row: UserRow): Promise<void>;
  updateUser(userId: string, patch: Partial<Pick<UserRow, "displayName" | "githubLogin" | "status">>, updatedAt: string): Promise<void>;

  // roles
  getRole(roleId: string): Promise<RoleRow | null>;
  getRoleByName(orgId: string, name: string): Promise<RoleRow | null>;
  listRoles(orgId: string, limit: number, cursor?: string): Promise<{ items: RoleRow[]; nextCursor: string | null }>;
  createRole(row: RoleRow): Promise<void>;
  updateRolePermissions(roleId: string, name: string | undefined, permissions: identity.PermissionKey[] | undefined, updatedAt: string): Promise<void>;
  deleteRole(roleId: string): Promise<void>; // cascades assignments + role_permissions

  // assignments
  listAssignmentsByUser(userId: string, orgId: string): Promise<AssignmentRow[]>;
  findAssignment(userId: string, roleId: string, orgId: string, resourceType: string | null, resourceId: string | null): Promise<AssignmentRow | null>;
  createAssignment(row: AssignmentRow): Promise<void>;
  getAssignment(assignmentId: string): Promise<AssignmentRow | null>;
  deleteAssignment(assignmentId: string): Promise<void>;

  // authz support: users in an org holding a given permission org-wide (last-admin guard)
  usersWithOrgWidePermission(orgId: string, permission: identity.PermissionKey): Promise<string[]>;
}
