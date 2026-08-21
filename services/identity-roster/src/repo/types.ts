// Repository boundary. Two implementations exist: D1IdentityRepo (production,
// namespace-scoped @dub/db) and MemIdentityRepo (tests + local dev). Route
// handlers depend only on this interface — the RBAC semantics live in authz.ts
// and are identical regardless of the backing store.
import type { identity } from "@dub/types";

// Provenance of a roster row. 'email-routing' rows are owned by the Email Routing
// sync (upsert-by-email); 'manual' rows are invited/provisioned the ordinary way.
export type UserSource = "manual" | "email-routing";

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
  source: UserSource;
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
  roleId?: string; // filter to users holding this role (any scope) — GET /users?role=
  q?: string; // free-text over displayName/email (case-insensitive) — GET /users?q=
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
  updateUser(userId: string, patch: Partial<Pick<UserRow, "displayName" | "githubLogin" | "status" | "source" | "avatarUrl">>, updatedAt: string): Promise<void>;
  /** All users in the org with a given provenance (used by the Email Routing sync to
   *  find rows it owns and logically deactivate the ones no longer present). */
  listUsersBySource(orgId: string, source: UserSource): Promise<UserRow[]>;

  // roles
  getRole(roleId: string): Promise<RoleRow | null>;
  getRoleByName(orgId: string, name: string): Promise<RoleRow | null>;
  listRoles(orgId: string, limit: number, cursor?: string): Promise<{ items: RoleRow[]; nextCursor: string | null }>;
  createRole(row: RoleRow): Promise<void>;
  updateRolePermissions(roleId: string, name: string | undefined, permissions: identity.PermissionKey[] | undefined, updatedAt: string): Promise<void>;
  deleteRole(roleId: string): Promise<void>; // cascades assignments + role_permissions
  /** roleId -> distinct users holding it (any scope) in the org. Roles with zero members are omitted. */
  roleMemberCounts(orgId: string): Promise<Map<string, number>>;

  // assignments
  listAssignmentsByUser(userId: string, orgId: string): Promise<AssignmentRow[]>;
  findAssignment(userId: string, roleId: string, orgId: string, resourceType: string | null, resourceId: string | null): Promise<AssignmentRow | null>;
  createAssignment(row: AssignmentRow): Promise<void>;
  getAssignment(assignmentId: string): Promise<AssignmentRow | null>;
  deleteAssignment(assignmentId: string): Promise<void>;

  // authz support: users in an org holding a given permission org-wide (last-admin guard)
  usersWithOrgWidePermission(orgId: string, permission: identity.PermissionKey): Promise<string[]>;
}
