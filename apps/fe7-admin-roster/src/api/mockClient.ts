// In-memory ResourceClient implementing the identity/audit contract surface.
// Powers the standalone dev harness and component/E2E tests (design §5: "P1
// 実装時の依存先はモックサーバ(契約準拠スタブ)"). NOT shipped to production —
// FE2 provides the real ResourceClient there.
import { identity } from "@dub/types"; // value import: identity.PERMISSION_CATALOG (runtime) + types
import type { common, auditLog, gateway } from "@dub/types";
import type { ResourceClient, ErrorResponse } from "../shell/contract";
import type { RoleAssignment } from "../contracts/pending";

function err(code: string, message: string, details?: unknown): ErrorResponse {
  return { error: { code, message, retryable: false, ...(details !== undefined ? { details } : {}) } };
}

const now = () => new Date().toISOString();

export interface MockSeed {
  me?: gateway.MeResponse;
}

interface MockState {
  users: Map<string, identity.IdentityUserDetail>;
  roles: Map<string, identity.Role>;
  assignments: Map<string, RoleAssignment[]>; // userId -> assignments
  audits: auditLog.AuditRecord[];
  me: gateway.MeResponse;
}

const ORG = "org_devhub";

function seedState(seed?: MockSeed): MockState {
  const roles = new Map<string, identity.Role>([
    ["role_admin", { id: "role_admin", orgId: ORG, name: "admin", permissions: ["identity:read", "identity:admin", "audit:read", "event:read"], isSystem: true }],
    ["role_member", { id: "role_member", orgId: ORG, name: "member", permissions: ["identity:read", "event:read"], isSystem: true }],
    ["role_organizer", { id: "role_organizer", orgId: ORG, name: "organizer", permissions: ["event:read", "event:write"], isSystem: false }],
  ]);
  const users = new Map<string, identity.IdentityUserDetail>([
    ["user_alice", { id: "user_alice", orgId: ORG, displayName: "Alice Admin", email: "alice@developershub.jp", githubLogin: "alice", avatarUrl: null, status: "active", roleIds: ["role_admin"], permissions: ["identity:read", "identity:admin", "audit:read", "event:read"], createdAt: now(), updatedAt: now() }],
    ["user_bob", { id: "user_bob", orgId: ORG, displayName: "Bob Member", email: "bob@developershub.jp", githubLogin: "bob", avatarUrl: null, status: "active", roleIds: ["role_member"], permissions: ["identity:read", "event:read"], createdAt: now(), updatedAt: now() }],
    ["user_carol", { id: "user_carol", orgId: ORG, displayName: "Carol Invited", email: "carol@developershub.jp", githubLogin: null, avatarUrl: null, status: "invited", roleIds: [], permissions: [], createdAt: now(), updatedAt: now() }],
  ]);
  const assignments = new Map<string, RoleAssignment[]>([
    ["user_alice", [{ id: "asg_1", userId: "user_alice", roleId: "role_admin", roleName: "admin", resourceType: null, resourceId: null, grantedBy: "user_alice", grantedAt: now() }]],
    ["user_bob", [{ id: "asg_2", userId: "user_bob", roleId: "role_member", roleName: "member", resourceType: null, resourceId: null, grantedBy: "user_alice", grantedAt: now() }]],
  ]);
  const audits: auditLog.AuditRecord[] = [
    { id: "aud_1", action: "identity.role.assigned", actorId: "user_alice", orgId: ORG, result: "success", resourceType: "user", resourceId: "user_bob", details: { roleId: "role_member" }, requestId: "req_1", occurredAt: now(), recordedAt: now() },
  ];
  const me: gateway.MeResponse = seed?.me ?? {
    user: { id: "user_alice", displayName: "Alice Admin", avatarUrl: null },
    orgId: ORG,
    permissions: ["identity:read", "identity:admin", "audit:read", "event:read"],
    sessionExpiresAt: Date.now() + 3600_000,
  };
  return { users, roles, assignments, audits, me };
}

function paginate<T>(items: T[]): common.Paginated<T> {
  return { items, nextCursor: null };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Construct an in-memory client. Each call gets isolated state. */
export function createMockClient(seed?: MockSeed): ResourceClient {
  const s = seedState(seed);

  async function get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    if (path.endsWith("/permissions/catalog")) return [...identity.PERMISSION_CATALOG] as unknown as T;
    if (path.endsWith("/identity/roles")) return paginate([...s.roles.values()]) as unknown as T;
    if (path.endsWith("/identity/users")) {
      let list = [...s.users.values()].map(stripDetail);
      const ids = query?.ids as string | undefined;
      if (ids) {
        const set = new Set(ids.split(","));
        list = list.filter((u) => set.has(u.id));
      }
      const status = query?.status as string | undefined;
      if (status) list = list.filter((u) => u.status === status);
      const q = query?.q as string | undefined;
      if (q) list = list.filter((u) => u.displayName.includes(q) || u.email.includes(q));
      return paginate(list) as unknown as T;
    }
    const rolesMatch = path.match(/\/identity\/users\/([^/]+)\/roles$/);
    if (rolesMatch) return (s.assignments.get(rolesMatch[1]!) ?? []) as unknown as T;
    const userMatch = path.match(/\/identity\/users\/([^/]+)$/);
    if (userMatch) {
      const u = s.users.get(userMatch[1]!);
      if (!u) throw err("NOT_FOUND", "user not found");
      return u as unknown as T;
    }
    if (path.endsWith("/audit/logs")) {
      const action = (query?.action as string | undefined) ?? "identity.";
      const filtered = s.audits.filter((a) => a.action.startsWith(action));
      return paginate(filtered) as unknown as T;
    }
    if (path.endsWith("/me")) return s.me as unknown as T;
    throw err("NOT_FOUND", `unhandled GET ${path}`);
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    if (path.endsWith("/users/invite")) {
      const req = body as identity.InviteUserRequest;
      if (!EMAIL_RE.test(req.email)) {
        throw err("VALIDATION_FAILED", "invalid email", [{ field: "email", reason: "format", message: "メール形式が不正です" }]);
      }
      if ([...s.users.values()].some((u) => u.email === req.email)) {
        throw err("CONFLICT", "email already exists");
      }
      const id = `user_${Math.random().toString(36).slice(2, 8)}`;
      const user: identity.IdentityUserDetail = {
        id, orgId: ORG, displayName: req.displayName ?? req.email, email: req.email,
        githubLogin: null, avatarUrl: null, status: "invited", roleIds: req.roleIds ?? [],
        permissions: [], createdAt: now(), updatedAt: now(),
      };
      s.users.set(id, user);
      return stripDetail(user) as unknown as T;
    }
    if (path.endsWith("/identity/roles")) {
      const req = body as { name: string; permissions: identity.PermissionKey[] };
      if (!req.name?.trim()) throw err("VALIDATION_FAILED", "name required", [{ field: "name", reason: "required" }]);
      if ([...s.roles.values()].some((r) => r.name === req.name)) throw err("CONFLICT", "role name exists");
      const id = `role_${Math.random().toString(36).slice(2, 8)}`;
      const role: identity.Role = { id, orgId: ORG, name: req.name, permissions: req.permissions, isSystem: false };
      s.roles.set(id, role);
      return role as unknown as T;
    }
    const assignMatch = path.match(/\/identity\/users\/([^/]+)\/roles$/);
    if (assignMatch) {
      const userId = assignMatch[1]!;
      const req = body as { roleId: string; resourceType?: string; resourceId?: string };
      const role = s.roles.get(req.roleId);
      if (!role) throw err("VALIDATION_FAILED", "unknown role", [{ field: "roleId", reason: "not_found" }]);
      const list = s.assignments.get(userId) ?? [];
      if (list.some((a) => a.roleId === req.roleId && a.resourceId === (req.resourceId ?? null))) {
        throw err("CONFLICT", "role already assigned");
      }
      const asg: RoleAssignment = {
        id: `asg_${Math.random().toString(36).slice(2, 8)}`, userId, roleId: req.roleId,
        roleName: role.name, resourceType: (req.resourceType as "event") ?? null,
        resourceId: req.resourceId ?? null, grantedBy: s.me.user.id, grantedAt: now(),
      };
      s.assignments.set(userId, [...list, asg]);
      return asg as unknown as T;
    }
    throw err("NOT_FOUND", `unhandled POST ${path}`);
  }

  async function patch<T>(path: string, body?: unknown): Promise<T> {
    const roleMatch = path.match(/\/identity\/roles\/([^/]+)$/);
    if (roleMatch) {
      const role = s.roles.get(roleMatch[1]!);
      if (!role) throw err("NOT_FOUND", "role not found");
      if (role.isSystem) throw err("CONFLICT", "system role is read-only");
      const req = body as { name?: string; permissions?: identity.PermissionKey[] };
      const updated: identity.Role = { ...role, ...(req.name !== undefined ? { name: req.name } : {}), ...(req.permissions !== undefined ? { permissions: req.permissions } : {}) };
      s.roles.set(role.id, updated);
      return updated as unknown as T;
    }
    const userMatch = path.match(/\/identity\/users\/([^/]+)$/);
    if (userMatch) {
      const u = s.users.get(userMatch[1]!);
      if (!u) throw err("NOT_FOUND", "user not found");
      const req = body as Partial<identity.IdentityUser>;
      const updated: identity.IdentityUserDetail = { ...u, ...req, updatedAt: now() };
      s.users.set(u.id, updated);
      return stripDetail(updated) as unknown as T;
    }
    throw err("NOT_FOUND", `unhandled PATCH ${path}`);
  }

  async function del(path: string): Promise<void> {
    const roleMatch = path.match(/\/identity\/roles\/([^/]+)$/);
    if (roleMatch) {
      const role = s.roles.get(roleMatch[1]!);
      if (!role) throw err("NOT_FOUND", "role not found");
      if (role.isSystem) throw err("CONFLICT", "system role cannot be deleted");
      s.roles.delete(role.id);
      return;
    }
    const asgMatch = path.match(/\/identity\/users\/([^/]+)\/roles\/([^/]+)$/);
    if (asgMatch) {
      const [, userId, asgId] = asgMatch;
      const list = s.assignments.get(userId!) ?? [];
      s.assignments.set(userId!, list.filter((a) => a.id !== asgId));
      return;
    }
    throw err("NOT_FOUND", `unhandled DELETE ${path}`);
  }

  return { get, post, patch, delete: del };
}

function stripDetail(u: identity.IdentityUserDetail): identity.IdentityUser {
  const { permissions: _permissions, ...rest } = u;
  return rest;
}
