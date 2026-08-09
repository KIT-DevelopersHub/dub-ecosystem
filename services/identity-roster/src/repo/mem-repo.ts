// In-memory IdentityRepo — backs the test suite and `wrangler dev --local` smoke
// runs. Mirrors the D1 DDL's unique constraints and ON DELETE CASCADE so tests
// exercise the same conflict/cascade semantics the production store enforces.
import type { identity } from "@dub/types";
import type {
  AssignmentRow,
  IdentityRepo,
  ListUsersFilter,
  OrgRow,
  RoleRow,
  UserPage,
  UserRow,
} from "./types";

function pageSlice<T extends { id: string }>(rows: T[], limit: number, cursor?: string): { items: T[]; nextCursor: string | null } {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = cursor ? sorted.findIndex((r) => r.id > cursor) : 0;
  const from = start < 0 ? sorted.length : start;
  const items = sorted.slice(from, from + limit);
  const nextCursor = from + limit < sorted.length && items.length > 0 ? items[items.length - 1]!.id : null;
  return { items, nextCursor };
}

export class MemIdentityRepo implements IdentityRepo {
  private orgs = new Map<string, OrgRow>();
  private users = new Map<string, UserRow>();
  private roles = new Map<string, RoleRow>();
  private assignments = new Map<string, AssignmentRow>();

  async getOrg(orgId: string): Promise<OrgRow | null> {
    return this.orgs.get(orgId) ?? null;
  }
  async createOrg(row: OrgRow): Promise<void> {
    this.orgs.set(row.id, { ...row });
  }
  async listOrgs(limit: number, cursor?: string) {
    return pageSlice([...this.orgs.values()], limit, cursor);
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const u = this.users.get(userId);
    return u ? { ...u } : null;
  }
  async getUserByEmail(orgId: string, email: string): Promise<UserRow | null> {
    for (const u of this.users.values()) {
      if (u.orgId === orgId && u.email.toLowerCase() === email.toLowerCase()) return { ...u };
    }
    return null;
  }
  async listUsers(filter: ListUsersFilter): Promise<UserPage> {
    let rows = [...this.users.values()].filter((u) => u.orgId === filter.orgId);
    if (filter.ids && filter.ids.length > 0) {
      const set = new Set(filter.ids);
      rows = rows.filter((u) => set.has(u.id));
    }
    if (filter.status) rows = rows.filter((u) => u.status === filter.status);
    return pageSlice(rows.map((u) => ({ ...u })), filter.limit, filter.cursor);
  }
  async createUser(row: UserRow): Promise<void> {
    this.users.set(row.id, { ...row });
  }
  async updateUser(
    userId: string,
    patch: Partial<Pick<UserRow, "displayName" | "githubLogin" | "status">>,
    updatedAt: string,
  ): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    this.users.set(userId, { ...u, ...patch, updatedAt });
  }

  async getRole(roleId: string): Promise<RoleRow | null> {
    const r = this.roles.get(roleId);
    return r ? { ...r, permissions: [...r.permissions] } : null;
  }
  async getRoleByName(orgId: string, name: string): Promise<RoleRow | null> {
    for (const r of this.roles.values()) {
      if (r.orgId === orgId && r.name === name) return { ...r, permissions: [...r.permissions] };
    }
    return null;
  }
  async listRoles(orgId: string, limit: number, cursor?: string) {
    const rows = [...this.roles.values()].filter((r) => r.orgId === orgId).map((r) => ({ ...r, permissions: [...r.permissions] }));
    return pageSlice(rows, limit, cursor);
  }
  async createRole(row: RoleRow): Promise<void> {
    this.roles.set(row.id, { ...row, permissions: [...row.permissions] });
  }
  async updateRolePermissions(
    roleId: string,
    name: string | undefined,
    permissions: identity.PermissionKey[] | undefined,
    updatedAt: string,
  ): Promise<void> {
    const r = this.roles.get(roleId);
    if (!r) return;
    this.roles.set(roleId, {
      ...r,
      ...(name !== undefined ? { name } : {}),
      ...(permissions !== undefined ? { permissions: [...permissions] } : {}),
      updatedAt,
    });
  }
  async deleteRole(roleId: string): Promise<void> {
    this.roles.delete(roleId);
    for (const [id, a] of this.assignments) if (a.roleId === roleId) this.assignments.delete(id); // CASCADE
  }

  async listAssignmentsByUser(userId: string, orgId: string): Promise<AssignmentRow[]> {
    return [...this.assignments.values()].filter((a) => a.userId === userId && a.orgId === orgId).map((a) => ({ ...a }));
  }
  async findAssignment(
    userId: string,
    roleId: string,
    orgId: string,
    resourceType: string | null,
    resourceId: string | null,
  ): Promise<AssignmentRow | null> {
    for (const a of this.assignments.values()) {
      if (
        a.userId === userId &&
        a.roleId === roleId &&
        a.orgId === orgId &&
        (a.resourceType ?? "") === (resourceType ?? "") &&
        (a.resourceId ?? "") === (resourceId ?? "")
      ) {
        return { ...a };
      }
    }
    return null;
  }
  async createAssignment(row: AssignmentRow): Promise<void> {
    this.assignments.set(row.id, { ...row });
  }
  async getAssignment(assignmentId: string): Promise<AssignmentRow | null> {
    const a = this.assignments.get(assignmentId);
    return a ? { ...a } : null;
  }
  async deleteAssignment(assignmentId: string): Promise<void> {
    this.assignments.delete(assignmentId);
  }

  async usersWithOrgWidePermission(orgId: string, permission: identity.PermissionKey): Promise<string[]> {
    const roleIds = new Set(
      [...this.roles.values()].filter((r) => r.orgId === orgId && r.permissions.includes(permission)).map((r) => r.id),
    );
    const users = new Set<string>();
    for (const a of this.assignments.values()) {
      if (a.orgId !== orgId) continue;
      if (a.resourceType !== null || a.resourceId !== null) continue;
      if (!roleIds.has(a.roleId)) continue;
      const u = this.users.get(a.userId);
      if (u && u.status === "active") users.add(u.id);
    }
    return [...users];
  }
}
