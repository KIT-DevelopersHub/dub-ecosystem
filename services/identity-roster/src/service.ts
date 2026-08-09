// Business logic for identity-roster. Throws DubError (mapped to the wire form by
// the Hono onError handler). Pure of transport concerns — routes parse/validate
// and call these methods. Audit/authz/revoke side effects go through Deps.
import { DubError, errors, CommonErrorCodes, type FieldError } from "@dub/errors";
import type { common, identity } from "@dub/types";
import type { Deps, RequestCtx } from "./deps";
import type { AssignmentRow, RoleRow, UserRow } from "./repo/types";
import { evaluate, effectiveOrgWidePermissions, type EvalContext } from "./authz";
import { isPermissionKey } from "./permissions";
import type {
  AssignRoleRequest,
  AssignRoleResult,
  CreateRoleRequest,
  EffectivePermissionsResponse,
  InviteUserResponse,
  ProvisionUserResponse,
  UpdateRoleRequest,
  UpdateUserRequest,
} from "./dto";

const ADMIN: identity.PermissionKey = "identity:admin";
const AUTHZ_TTL_SECONDS = 60;
const MAX_BATCH_CHECKS = 20;
const MAX_IDS = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class IdentityService {
  constructor(private readonly d: Deps) {}

  // ---------- read helpers ----------
  private orgWideRoleIds(assignments: AssignmentRow[]): common.RoleId[] {
    const set = new Set<string>();
    for (const a of assignments) if (a.resourceType === null && a.resourceId === null) set.add(a.roleId);
    return [...set];
  }

  private toIdentityUser(u: UserRow, assignments: AssignmentRow[]): identity.IdentityUser {
    return {
      id: u.id,
      orgId: u.orgId,
      displayName: u.displayName,
      email: u.email,
      githubLogin: u.githubLogin,
      avatarUrl: u.avatarUrl,
      status: u.status,
      roleIds: this.orgWideRoleIds(assignments),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }

  private toRole(r: RoleRow): identity.Role {
    return { id: r.id, orgId: r.orgId, name: r.name, permissions: r.permissions, isSystem: r.isSystem };
  }

  private async loadEvalContext(userId: string, orgId: string): Promise<EvalContext> {
    const user = await this.d.repo.getUser(userId);
    const assignments = user ? await this.d.repo.listAssignmentsByUser(userId, orgId) : [];
    const roleById = new Map<string, RoleRow>();
    for (const a of assignments) {
      if (roleById.has(a.roleId)) continue;
      const role = await this.d.repo.getRole(a.roleId);
      if (role) roleById.set(role.id, role);
    }
    return { user, orgId, roleById, assignments };
  }

  // ---------- orgs / users read ----------
  async listOrgs(limit?: number, cursor?: string): Promise<common.Paginated<identity.Org>> {
    const page = await this.d.repo.listOrgs(clampLimit(limit), cursor);
    return { items: page.items.map((o) => ({ id: o.id, name: o.name, createdAt: o.createdAt })), nextCursor: page.nextCursor };
  }

  async listUsers(
    orgId: string,
    opts: { ids?: string[]; status?: identity.UserStatus; limit?: number; cursor?: string },
  ): Promise<common.Paginated<identity.IdentityUser>> {
    if (opts.ids && opts.ids.length > MAX_IDS) {
      throw errors.validationFailed([{ field: "ids", reason: "too_long", message: `max ${MAX_IDS}` }]);
    }
    if (opts.ids && opts.ids.length > 0 && (opts.status || opts.cursor)) {
      throw errors.validationFailed([{ field: "ids", reason: "exclusive", message: "ids cannot combine with other filters" }]);
    }
    const page = await this.d.repo.listUsers({
      orgId,
      ...(opts.ids ? { ids: opts.ids } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      limit: clampLimit(opts.limit),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    const items: identity.IdentityUser[] = [];
    for (const u of page.items) {
      const assignments = await this.d.repo.listAssignmentsByUser(u.id, orgId);
      items.push(this.toIdentityUser(u, assignments));
    }
    return { items, nextCursor: page.nextCursor };
  }

  async getUserDetail(userId: string, orgId: string): Promise<identity.IdentityUserDetail> {
    const user = await this.d.repo.getUser(userId);
    if (!user) throw errors.notFound("user", userId);
    const ctx = await this.loadEvalContext(userId, orgId);
    const base = this.toIdentityUser(user, ctx.assignments);
    return { ...base, permissions: effectiveOrgWidePermissions(ctx) };
  }

  // ---------- invite / provision ----------
  async invite(orgId: string, req: { email: string; displayName?: string; roleIds?: string[] }, ctx: RequestCtx): Promise<InviteUserResponse> {
    const email = requireEmail(req.email);
    const org = await this.d.repo.getOrg(orgId);
    if (!org) throw errors.notFound("org", orgId);
    const existing = await this.d.repo.getUserByEmail(orgId, email);
    if (existing) throw errors.conflict(`email already on roster: ${email}`, { code: "EMAIL_EXISTS" });

    const roleIds = req.roleIds ?? [];
    for (const rid of roleIds) {
      const role = await this.d.repo.getRole(rid);
      if (!role || role.orgId !== orgId) throw errors.validationFailed([{ field: "roleIds", reason: "unknown_role", message: rid }]);
    }

    const now = this.d.now();
    const user: UserRow = {
      id: this.d.newId("user"),
      orgId,
      email,
      displayName: req.displayName ?? email.split("@")[0]!,
      githubLogin: null,
      avatarUrl: null,
      status: "invited",
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repo.createUser(user);
    for (const rid of roleIds) {
      await this.d.repo.createAssignment({
        id: this.d.newId("ra"),
        userId: user.id,
        roleId: rid,
        orgId,
        resourceType: null,
        resourceId: null,
        grantedBy: ctx.actorId ?? user.id,
        grantedAt: now,
      });
    }
    await this.d.audit.publish(this.record("identity.user.invited", "success", ctx, orgId, "user", user.id, { email }));
    const assignments = await this.d.repo.listAssignmentsByUser(user.id, orgId);
    return { user: this.toIdentityUser(user, assignments) };
  }

  async provision(orgId: string, req: { email: string; displayName: string; githubLogin?: string }, ctx: RequestCtx): Promise<ProvisionUserResponse> {
    const email = requireEmail(req.email);
    const existing = await this.d.repo.getUserByEmail(orgId, email);

    // invite-only: no roster row => rejected, no row created.
    if (!existing) {
      await this.d.audit.publish(this.record("identity.user.provisioned", "denied", ctx, orgId, "user", null, { email, reason: "not_invited" }));
      return { status: "rejected", user: null };
    }

    // already active => idempotent no-op.
    if (existing.status === "active") {
      const assignments = await this.d.repo.listAssignmentsByUser(existing.id, orgId);
      return { status: "existing", user: this.toIdentityUser(existing, assignments) };
    }
    if (existing.status === "rejected" || existing.status === "disabled") {
      throw errors.conflict(`user is ${existing.status}; cannot provision`, { code: "USER_NOT_INVITED" });
    }

    // invited -> active. Write-ahead sync audit (fail-close) before the D1 commit.
    const now = this.d.now();
    await this.d.audit.logSync(this.record("identity.user.provisioned", "success", ctx, orgId, "user", existing.id, { email }));
    await this.d.repo.updateUser(
      existing.id,
      { status: "active", displayName: req.displayName || existing.displayName, ...(req.githubLogin ? { githubLogin: req.githubLogin } : {}) },
      now,
    );
    const updated = (await this.d.repo.getUser(existing.id))!;
    const assignments = await this.d.repo.listAssignmentsByUser(updated.id, orgId);
    return { status: "provisioned", user: this.toIdentityUser(updated, assignments) };
  }

  async updateUser(userId: string, orgId: string, req: UpdateUserRequest, ctx: RequestCtx): Promise<identity.IdentityUser> {
    const user = await this.d.repo.getUser(userId);
    if (!user || user.orgId !== orgId) throw errors.notFound("user", userId);

    const disabling = req.status !== undefined && req.status !== "active" && user.status === "active";
    if (disabling) {
      // lockout guard: don't disable the org's last active identity:admin holder.
      const admins = await this.d.repo.usersWithOrgWidePermission(orgId, ADMIN);
      if (admins.length === 1 && admins[0] === userId) {
        throw errors.conflict("cannot disable the last identity:admin holder", { code: "LAST_ADMIN" });
      }
      // fail-close: revoke live sessions first; if that fails, abort the status change.
      await this.d.revoker.revokeUser(userId, ctx);
    }

    const patch: Partial<Pick<UserRow, "displayName" | "githubLogin" | "status">> = {};
    if (req.displayName !== undefined) patch.displayName = req.displayName;
    if (req.githubLogin !== undefined) patch.githubLogin = req.githubLogin;
    if (req.status !== undefined) patch.status = req.status;

    await this.d.repo.updateUser(userId, patch, this.d.now());
    await this.d.audit.publish(this.record("identity.user.updated", "success", ctx, orgId, "user", userId, { fields: Object.keys(patch) }));
    const updated = (await this.d.repo.getUser(userId))!;
    const assignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    return this.toIdentityUser(updated, assignments);
  }

  // ---------- roles ----------
  async listRoles(orgId: string, limit?: number, cursor?: string): Promise<common.Paginated<identity.Role>> {
    const page = await this.d.repo.listRoles(orgId, clampLimit(limit), cursor);
    return { items: page.items.map((r) => this.toRole(r)), nextCursor: page.nextCursor };
  }

  async createRole(orgId: string, req: CreateRoleRequest, ctx: RequestCtx): Promise<identity.Role> {
    const name = requireNonEmpty(req.name, "name");
    assertPermissionKeys(req.permissions);
    const org = await this.d.repo.getOrg(orgId);
    if (!org) throw errors.notFound("org", orgId);
    if (await this.d.repo.getRoleByName(orgId, name)) throw errors.conflict(`role name exists: ${name}`, { code: "ROLE_NAME_EXISTS" });

    const now = this.d.now();
    const role: RoleRow = { id: this.d.newId("role"), orgId, name, isSystem: false, permissions: dedupePerms(req.permissions), createdAt: now, updatedAt: now };
    await this.d.repo.createRole(role);
    await this.d.audit.publish(this.record("identity.role.created", "success", ctx, orgId, "role", role.id, { name }));
    return this.toRole(role);
  }

  async updateRole(roleId: string, orgId: string, req: UpdateRoleRequest, ctx: RequestCtx): Promise<identity.Role> {
    const role = await this.d.repo.getRole(roleId);
    if (!role || role.orgId !== orgId) throw errors.notFound("role", roleId);
    if (req.permissions !== undefined) assertPermissionKeys(req.permissions);
    if (req.name !== undefined && req.name !== role.name) {
      const clash = await this.d.repo.getRoleByName(orgId, req.name);
      if (clash) throw errors.conflict(`role name exists: ${req.name}`, { code: "ROLE_NAME_EXISTS" });
    }
    await this.d.repo.updateRolePermissions(
      roleId,
      req.name,
      req.permissions !== undefined ? dedupePerms(req.permissions) : undefined,
      this.d.now(),
    );
    await this.d.audit.publish(this.record("identity.role.updated", "success", ctx, orgId, "role", roleId, { permissionChange: req.permissions !== undefined }));
    return this.toRole((await this.d.repo.getRole(roleId))!);
  }

  async deleteRole(roleId: string, orgId: string, ctx: RequestCtx): Promise<void> {
    const role = await this.d.repo.getRole(roleId);
    if (!role || role.orgId !== orgId) throw errors.notFound("role", roleId);
    if (role.isSystem) throw errors.conflict("system roles are not deletable", { code: "SYSTEM_ROLE" });
    await this.d.repo.deleteRole(roleId);
    await this.d.audit.publish(this.record("identity.role.deleted", "success", ctx, orgId, "role", roleId, {}));
  }

  // ---------- assignments ----------
  async assignRole(userId: string, orgId: string, req: AssignRoleRequest, ctx: RequestCtx): Promise<AssignRoleResult> {
    const user = await this.d.repo.getUser(userId);
    if (!user || user.orgId !== orgId) throw errors.notFound("user", userId);
    const role = await this.d.repo.getRole(req.roleId);
    if (!role || role.orgId !== orgId) throw errors.notFound("role", req.roleId);

    const resourceType = req.resourceType ?? null;
    const resourceId = req.resourceId ?? null;
    if ((resourceType === null) !== (resourceId === null)) {
      throw errors.validationFailed([{ field: "resourceId", reason: "scope_incomplete", message: "resourceType and resourceId must be set together" }]);
    }
    if (await this.d.repo.findAssignment(userId, req.roleId, orgId, resourceType, resourceId)) {
      throw errors.conflict("assignment already exists", { code: "ASSIGNMENT_EXISTS" });
    }

    const now = this.d.now();
    const assignment: AssignmentRow = {
      id: this.d.newId("ra"),
      userId,
      roleId: req.roleId,
      orgId,
      resourceType,
      resourceId,
      grantedBy: ctx.actorId ?? userId,
      grantedAt: now,
    };
    // write-ahead sync audit (SYNC_AUDIT_ACTIONS: identity.role.assigned).
    await this.d.audit.logSync(this.record("identity.role.assigned", "success", ctx, orgId, "user", userId, { roleId: req.roleId, resourceType, resourceId }));
    await this.d.repo.createAssignment(assignment);
    return { assignmentId: assignment.id };
  }

  async revokeRole(userId: string, assignmentId: string, orgId: string, ctx: RequestCtx): Promise<void> {
    const assignment = await this.d.repo.getAssignment(assignmentId);
    if (!assignment || assignment.userId !== userId || assignment.orgId !== orgId) throw errors.notFound("assignment", assignmentId);

    const role = await this.d.repo.getRole(assignment.roleId);
    const grantsAdmin = !!role && role.permissions.includes(ADMIN) && assignment.resourceType === null && assignment.resourceId === null;
    if (grantsAdmin) {
      const admins = await this.d.repo.usersWithOrgWidePermission(orgId, ADMIN);
      const userAdminGrants = await this.countOrgWideAdminGrants(userId, orgId);
      if (admins.length === 1 && admins[0] === userId && userAdminGrants === 1) {
        throw errors.conflict("cannot revoke the last identity:admin grant in the org", { code: "LAST_ADMIN" });
      }
    }
    // write-ahead sync audit (SYNC_AUDIT_ACTIONS: identity.role.revoked).
    await this.d.audit.logSync(this.record("identity.role.revoked", "success", ctx, orgId, "user", userId, { assignmentId, roleId: assignment.roleId }));
    await this.d.repo.deleteAssignment(assignmentId);
  }

  private async countOrgWideAdminGrants(userId: string, orgId: string): Promise<number> {
    const assignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    let n = 0;
    for (const a of assignments) {
      if (a.resourceType !== null || a.resourceId !== null) continue;
      const role = await this.d.repo.getRole(a.roleId);
      if (role && role.permissions.includes(ADMIN)) n++;
    }
    return n;
  }

  // ---------- authz ----------
  async authzCheck(req: identity.AuthzCheckRequest): Promise<identity.AuthzCheckResponse> {
    if (!Array.isArray(req.checks) || req.checks.length < 1 || req.checks.length > MAX_BATCH_CHECKS) {
      throw errors.validationFailed([{ field: "checks", reason: req.checks && req.checks.length > MAX_BATCH_CHECKS ? "too_long" : "required", message: `1..${MAX_BATCH_CHECKS}` }]);
    }
    const ctx = await this.loadEvalContext(req.subjectUserId, req.orgId);
    const evaluatedAt = this.d.now();
    const decisions: identity.AuthzDecision[] = req.checks.map((q) => ({
      allowed: evaluate(ctx, q),
      evaluatedAt,
      ttlSeconds: AUTHZ_TTL_SECONDS,
    }));
    return { decisions };
  }

  /** Single-check evaluation used by the service's own dogfood authz middleware. */
  async can(userId: string, orgId: string, q: identity.AuthzQuery): Promise<boolean> {
    const ctx = await this.loadEvalContext(userId, orgId);
    return evaluate(ctx, q);
  }

  async effectivePermissions(userId: string, orgId: string): Promise<EffectivePermissionsResponse> {
    const ctx = await this.loadEvalContext(userId, orgId);
    return { userId, orgId, permissions: effectiveOrgWidePermissions(ctx) };
  }

  // ---------- audit record builder ----------
  private record(
    action: string,
    result: "success" | "failure" | "denied",
    ctx: RequestCtx,
    orgId: string,
    resourceType: string | null,
    resourceId: string | null,
    details: Record<string, unknown>,
  ): import("@dub/types").auditLog.AuditRecordInput {
    return {
      action,
      actorId: ctx.actorId,
      orgId,
      result,
      resourceType,
      resourceId,
      details,
      requestId: ctx.requestId,
      occurredAt: this.d.now(),
    };
  }
}

// ---------- validation helpers ----------
function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}
function requireEmail(email: string): string {
  const v = (email ?? "").trim();
  if (!v || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
    throw errors.validationFailed([{ field: "email", reason: "invalid" }]);
  }
  return v.toLowerCase();
}
function requireNonEmpty(v: string, field: string): string {
  const s = (v ?? "").trim();
  if (!s) throw errors.validationFailed([{ field, reason: "required" }]);
  return s;
}
function assertPermissionKeys(keys: unknown): asserts keys is identity.PermissionKey[] {
  if (!Array.isArray(keys)) throw errors.validationFailed([{ field: "permissions", reason: "invalid" }]);
  const bad: FieldError[] = [];
  keys.forEach((k, i) => {
    if (typeof k !== "string" || !isPermissionKey(k)) bad.push({ field: `permissions[${i}]`, reason: "not_in_catalog", message: String(k) });
  });
  if (bad.length > 0) throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "unknown permission key(s)", { details: bad });
}
function dedupePerms(keys: identity.PermissionKey[]): identity.PermissionKey[] {
  return [...new Set(keys)];
}
