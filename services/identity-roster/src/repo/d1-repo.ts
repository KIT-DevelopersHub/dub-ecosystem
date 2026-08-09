// D1-backed IdentityRepo. Uses the namespace-scoped @dub/db client (enforcement
// "strict" => statements may only touch identity_* tables). No runtime DDL.
import type { identity } from "@dub/types";
import type { DbClient } from "@dub/db";
import type {
  AssignmentRow,
  IdentityRepo,
  ListUsersFilter,
  OrgRow,
  RoleRow,
  UserPage,
  UserRow,
} from "./types";

interface UserDb {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  github_login: string | null;
  avatar_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
interface RoleDb {
  id: string;
  org_id: string;
  name: string;
  is_system: number;
  created_at: string;
  updated_at: string;
}
interface AssignmentDb {
  id: string;
  user_id: string;
  role_id: string;
  org_id: string;
  resource_type: string | null;
  resource_id: string | null;
  granted_by: string;
  granted_at: string;
}

function toUser(r: UserDb): UserRow {
  return {
    id: r.id,
    orgId: r.org_id,
    email: r.email,
    displayName: r.display_name,
    githubLogin: r.github_login,
    avatarUrl: r.avatar_url,
    status: r.status as identity.UserStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toAssignment(r: AssignmentDb): AssignmentRow {
  return {
    id: r.id,
    userId: r.user_id,
    roleId: r.role_id,
    orgId: r.org_id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  };
}

export class D1IdentityRepo implements IdentityRepo {
  constructor(private readonly db: DbClient) {}

  private async permissionsOf(roleId: string): Promise<identity.PermissionKey[]> {
    const rows = await this.db.all<{ permission_key: string }>(
      "SELECT permission_key FROM identity_role_permissions WHERE role_id = ?",
      roleId,
    );
    return rows.map((r) => r.permission_key as identity.PermissionKey);
  }
  private toRole(r: RoleDb, permissions: identity.PermissionKey[]): RoleRow {
    return {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      isSystem: r.is_system === 1,
      permissions,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async getOrg(orgId: string): Promise<OrgRow | null> {
    const r = await this.db.first<{ id: string; name: string; created_at: string }>(
      "SELECT id, name, created_at FROM identity_orgs WHERE id = ?",
      orgId,
    );
    return r ? { id: r.id, name: r.name, createdAt: r.created_at } : null;
  }
  async createOrg(row: OrgRow): Promise<void> {
    await this.db.run("INSERT INTO identity_orgs (id, name, created_at) VALUES (?, ?, ?)", row.id, row.name, row.createdAt);
  }
  async listOrgs(limit: number, cursor?: string) {
    const rows = await this.db.all<{ id: string; name: string; created_at: string }>(
      "SELECT id, name, created_at FROM identity_orgs WHERE id > ? ORDER BY id LIMIT ?",
      cursor ?? "",
      limit,
    );
    const items = rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
    return { items, nextCursor: items.length === limit ? items[items.length - 1]!.id : null };
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const r = await this.db.first<UserDb>("SELECT * FROM identity_users WHERE id = ?", userId);
    return r ? toUser(r) : null;
  }
  async getUserByEmail(orgId: string, email: string): Promise<UserRow | null> {
    const r = await this.db.first<UserDb>(
      "SELECT * FROM identity_users WHERE org_id = ? AND lower(email) = lower(?)",
      orgId,
      email,
    );
    return r ? toUser(r) : null;
  }
  async listUsers(filter: ListUsersFilter): Promise<UserPage> {
    if (filter.ids && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => "?").join(", ");
      const rows = await this.db.all<UserDb>(
        `SELECT * FROM identity_users WHERE org_id = ? AND id IN (${placeholders}) ORDER BY id`,
        filter.orgId,
        ...filter.ids,
      );
      return { items: rows.map(toUser), nextCursor: null };
    }
    const clauses = ["org_id = ?", "id > ?"];
    const binds: unknown[] = [filter.orgId, filter.cursor ?? ""];
    if (filter.status) {
      clauses.push("status = ?");
      binds.push(filter.status);
    }
    const rows = await this.db.all<UserDb>(
      `SELECT * FROM identity_users WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
      ...binds,
      filter.limit,
    );
    const items = rows.map(toUser);
    return { items, nextCursor: items.length === filter.limit ? items[items.length - 1]!.id : null };
  }
  async createUser(row: UserRow): Promise<void> {
    await this.db.run(
      `INSERT INTO identity_users (id, org_id, email, display_name, github_login, avatar_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.orgId,
      row.email,
      row.displayName,
      row.githubLogin,
      row.avatarUrl,
      row.status,
      row.createdAt,
      row.updatedAt,
    );
  }
  async updateUser(
    userId: string,
    patch: Partial<Pick<UserRow, "displayName" | "githubLogin" | "status">>,
    updatedAt: string,
  ): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      binds.push(patch.displayName);
    }
    if (patch.githubLogin !== undefined) {
      sets.push("github_login = ?");
      binds.push(patch.githubLogin);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      binds.push(patch.status);
    }
    sets.push("updated_at = ?");
    binds.push(updatedAt);
    binds.push(userId);
    await this.db.run(`UPDATE identity_users SET ${sets.join(", ")} WHERE id = ?`, ...binds);
  }

  async getRole(roleId: string): Promise<RoleRow | null> {
    const r = await this.db.first<RoleDb>("SELECT * FROM identity_roles WHERE id = ?", roleId);
    if (!r) return null;
    return this.toRole(r, await this.permissionsOf(roleId));
  }
  async getRoleByName(orgId: string, name: string): Promise<RoleRow | null> {
    const r = await this.db.first<RoleDb>("SELECT * FROM identity_roles WHERE org_id = ? AND name = ?", orgId, name);
    if (!r) return null;
    return this.toRole(r, await this.permissionsOf(r.id));
  }
  async listRoles(orgId: string, limit: number, cursor?: string) {
    const rows = await this.db.all<RoleDb>(
      "SELECT * FROM identity_roles WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?",
      orgId,
      cursor ?? "",
      limit,
    );
    const items: RoleRow[] = [];
    for (const r of rows) items.push(this.toRole(r, await this.permissionsOf(r.id)));
    return { items, nextCursor: items.length === limit ? items[items.length - 1]!.id : null };
  }
  async createRole(row: RoleRow): Promise<void> {
    const stmts = [
      {
        sql: "INSERT INTO identity_roles (id, org_id, name, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        binds: [row.id, row.orgId, row.name, row.isSystem ? 1 : 0, row.createdAt, row.updatedAt],
      },
      ...row.permissions.map((p) => ({
        sql: "INSERT INTO identity_role_permissions (role_id, permission_key) VALUES (?, ?)",
        binds: [row.id, p],
      })),
    ];
    await this.db.batch(stmts);
  }
  async updateRolePermissions(
    roleId: string,
    name: string | undefined,
    permissions: identity.PermissionKey[] | undefined,
    updatedAt: string,
  ): Promise<void> {
    const stmts: { sql: string; binds: readonly unknown[] }[] = [];
    if (name !== undefined) {
      stmts.push({ sql: "UPDATE identity_roles SET name = ?, updated_at = ? WHERE id = ?", binds: [name, updatedAt, roleId] });
    } else {
      stmts.push({ sql: "UPDATE identity_roles SET updated_at = ? WHERE id = ?", binds: [updatedAt, roleId] });
    }
    if (permissions !== undefined) {
      stmts.push({ sql: "DELETE FROM identity_role_permissions WHERE role_id = ?", binds: [roleId] });
      for (const p of permissions) {
        stmts.push({ sql: "INSERT INTO identity_role_permissions (role_id, permission_key) VALUES (?, ?)", binds: [roleId, p] });
      }
    }
    await this.db.batch(stmts);
  }
  async deleteRole(roleId: string): Promise<void> {
    await this.db.batch([
      { sql: "DELETE FROM identity_role_assignments WHERE role_id = ?", binds: [roleId] },
      { sql: "DELETE FROM identity_role_permissions WHERE role_id = ?", binds: [roleId] },
      { sql: "DELETE FROM identity_roles WHERE id = ?", binds: [roleId] },
    ]);
  }

  async listAssignmentsByUser(userId: string, orgId: string): Promise<AssignmentRow[]> {
    const rows = await this.db.all<AssignmentDb>(
      "SELECT * FROM identity_role_assignments WHERE user_id = ? AND org_id = ?",
      userId,
      orgId,
    );
    return rows.map(toAssignment);
  }
  async findAssignment(
    userId: string,
    roleId: string,
    orgId: string,
    resourceType: string | null,
    resourceId: string | null,
  ): Promise<AssignmentRow | null> {
    const r = await this.db.first<AssignmentDb>(
      `SELECT * FROM identity_role_assignments
       WHERE user_id = ? AND role_id = ? AND org_id = ?
         AND COALESCE(resource_type, '') = ? AND COALESCE(resource_id, '') = ?`,
      userId,
      roleId,
      orgId,
      resourceType ?? "",
      resourceId ?? "",
    );
    return r ? toAssignment(r) : null;
  }
  async createAssignment(row: AssignmentRow): Promise<void> {
    await this.db.run(
      `INSERT INTO identity_role_assignments (id, user_id, role_id, org_id, resource_type, resource_id, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.userId,
      row.roleId,
      row.orgId,
      row.resourceType,
      row.resourceId,
      row.grantedBy,
      row.grantedAt,
    );
  }
  async getAssignment(assignmentId: string): Promise<AssignmentRow | null> {
    const r = await this.db.first<AssignmentDb>("SELECT * FROM identity_role_assignments WHERE id = ?", assignmentId);
    return r ? toAssignment(r) : null;
  }
  async deleteAssignment(assignmentId: string): Promise<void> {
    await this.db.run("DELETE FROM identity_role_assignments WHERE id = ?", assignmentId);
  }

  async usersWithOrgWidePermission(orgId: string, permission: identity.PermissionKey): Promise<string[]> {
    const rows = await this.db.all<{ user_id: string }>(
      `SELECT DISTINCT a.user_id
         FROM identity_role_assignments a
         JOIN identity_role_permissions rp ON rp.role_id = a.role_id
         JOIN identity_users u ON u.id = a.user_id
        WHERE a.org_id = ?
          AND a.resource_type IS NULL AND a.resource_id IS NULL
          AND rp.permission_key = ?
          AND u.status = 'active'`,
      orgId,
      permission,
    );
    return rows.map((r) => r.user_id);
  }
}
