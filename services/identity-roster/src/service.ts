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
  CreateRoleRequest,
  EffectivePermissionsResponse,
  EmailRoutingDiffRow,
  EmailRoutingSyncPreview,
  IdentityUserDetailView,
  IdentityUserView,
  InviteUserResponse,
  OffboardUserResult,
  OffboardStepResult,
  ProvisionUserResponse,
  RoleAssignmentView,
  RoleWithMemberCount,
  SyncEmailRoutingRequest,
  SyncEmailRoutingResult,
  UpdateRoleRequest,
  UpdateUserRequest,
} from "./dto";

const ADMIN: identity.PermissionKey = "identity:admin";
const AUTHZ_TTL_SECONDS = 60;
const MAX_BATCH_CHECKS = 20;
const MAX_IDS = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_DISPLAY_NAME_LEN = 80;
// Stop-gap cap for an inline data: URL avatar (≈512KB of base64). 本番課題(TODO): store
// avatar images in R2 and persist only the object URL, dropping this inline path.
const MAX_AVATAR_URL_LEN = 700_000;

export class IdentityService {
  constructor(private readonly d: Deps) {}

  // ---------- read helpers ----------
  private orgWideRoleIds(assignments: AssignmentRow[]): common.RoleId[] {
    const set = new Set<string>();
    for (const a of assignments) if (a.resourceType === null && a.resourceId === null) set.add(a.roleId);
    return [...set];
  }

  private toIdentityUser(u: UserRow, assignments: AssignmentRow[]): IdentityUserView {
    return {
      id: u.id,
      orgId: u.orgId,
      displayName: u.displayName,
      email: u.email,
      githubLogin: u.githubLogin,
      avatarUrl: u.avatarUrl,
      status: u.status,
      source: u.source,
      roleIds: this.orgWideRoleIds(assignments),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }

  private toRole(r: RoleRow): identity.Role {
    return { id: r.id, orgId: r.orgId, name: r.name, permissions: r.permissions, isSystem: r.isSystem };
  }

  private toAssignmentView(a: AssignmentRow, roleName: string): RoleAssignmentView {
    return {
      id: a.id,
      userId: a.userId,
      roleId: a.roleId,
      roleName,
      resourceType: a.resourceType,
      resourceId: a.resourceId,
      grantedBy: a.grantedBy,
      grantedAt: a.grantedAt,
    };
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
    opts: { ids?: string[]; status?: identity.UserStatus; roleId?: string; q?: string; limit?: number; cursor?: string },
  ): Promise<common.Paginated<identity.IdentityUser>> {
    if (opts.ids && opts.ids.length > MAX_IDS) {
      throw errors.validationFailed([{ field: "ids", reason: "too_long", message: `max ${MAX_IDS}` }]);
    }
    if (opts.ids && opts.ids.length > 0 && (opts.status || opts.cursor || opts.roleId || opts.q)) {
      throw errors.validationFailed([{ field: "ids", reason: "exclusive", message: "ids cannot combine with other filters" }]);
    }
    const page = await this.d.repo.listUsers({
      orgId,
      ...(opts.ids ? { ids: opts.ids } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.roleId ? { roleId: opts.roleId } : {}),
      ...(opts.q ? { q: opts.q } : {}),
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

  async getUserDetail(userId: string, orgId: string): Promise<IdentityUserDetailView> {
    const user = await this.d.repo.getUser(userId);
    if (!user) throw errors.notFound("user", userId);
    const ctx = await this.loadEvalContext(userId, orgId);
    const base = this.toIdentityUser(user, ctx.assignments);
    return { ...base, permissions: effectiveOrgWidePermissions(ctx) };
  }

  /** Identity master for a user (no permission fan-out). Internal S2S read — the
   *  api-gateway /me composition calls this to resolve the caller's own record. */
  async getUser(userId: string, orgId: string): Promise<identity.IdentityUser> {
    const user = await this.d.repo.getUser(userId);
    if (!user || user.orgId !== orgId) throw errors.notFound("user", userId);
    const assignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    return this.toIdentityUser(user, assignments);
  }

  /** Read-only lookup by email for the auth-service login allowlist. Returns the
   *  canonical roster user (ANY status) or null when the email is not on the
   *  roster. Unlike provision() this has NO side effects (it never activates an
   *  invited user) — auth-service enforces the active-only allowlist on the result. */
  async lookupByEmail(orgId: string, email: string): Promise<{ user: identity.IdentityUser | null }> {
    const normalized = (email ?? "").trim().toLowerCase();
    if (!normalized) return { user: null };
    const user = await this.d.repo.getUserByEmail(orgId, normalized);
    if (!user) return { user: null };
    const assignments = await this.d.repo.listAssignmentsByUser(user.id, orgId);
    return { user: this.toIdentityUser(user, assignments) };
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
      source: "manual",
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

  /**
   * Self profile edit (アカウント設定 → 表示名/アバター). The signed-in user updates their
   * OWN display name and/or avatar. The gateway scopes this to the caller's session id
   * (no admin gate, no target id from the client), and this method NEVER touches
   * status/roles/source — so it can neither escalate nor lock the org out. Separate from
   * the admin `updateUser` on purpose. Validation: displayName (when present) must be a
   * non-empty ≤80 chars; avatarUrl accepts a URL or an inline `data:` URL string
   * (最小実装), or null to clear it. 本番課題(TODO): move avatar images to an R2 object
   * store and persist only the object URL — the length cap below is a stop-gap so an
   * oversized inline data URL can't bloat the D1 TEXT column.
   */
  async updateOwnProfile(
    userId: string,
    orgId: string,
    req: { displayName?: string; avatarUrl?: string | null },
    ctx: RequestCtx,
  ): Promise<identity.IdentityUser> {
    const user = await this.d.repo.getUser(userId);
    if (!user || user.orgId !== orgId) throw errors.notFound("user", userId);

    const patch: Partial<Pick<UserRow, "displayName" | "avatarUrl">> = {};
    if (req.displayName !== undefined) {
      if (typeof req.displayName !== "string") throw errors.validationFailed([{ field: "displayName", reason: "invalid" }]);
      const dn = req.displayName.trim();
      if (!dn) throw errors.validationFailed([{ field: "displayName", reason: "required" }]);
      if (dn.length > MAX_DISPLAY_NAME_LEN) throw errors.validationFailed([{ field: "displayName", reason: "too_long" }]);
      patch.displayName = dn;
    }
    if (req.avatarUrl !== undefined) {
      if (req.avatarUrl === null) {
        patch.avatarUrl = null;
      } else if (typeof req.avatarUrl !== "string") {
        throw errors.validationFailed([{ field: "avatarUrl", reason: "invalid" }]);
      } else if (req.avatarUrl.length > MAX_AVATAR_URL_LEN) {
        throw errors.validationFailed([{ field: "avatarUrl", reason: "too_long" }]);
      } else {
        patch.avatarUrl = req.avatarUrl;
      }
    }

    if (Object.keys(patch).length > 0) {
      await this.d.repo.updateUser(userId, patch, this.d.now());
      await this.d.audit.publish(
        this.record("identity.user.profile_updated", "success", ctx, orgId, "user", userId, { fields: Object.keys(patch) }),
      );
    }
    const updated = (await this.d.repo.getUser(userId))!;
    const assignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    return this.toIdentityUser(updated, assignments);
  }

  // ---------- offboarding (退任): one-shot within identity ----------
  /**
   * Retire an account in one call: revoke live sessions (fail-close), strip every role
   * assignment (org-wide + resource-scoped), then disable the account. Idempotent — a
   * re-run on an already-disabled, role-less user is a no-op that still returns 200 with
   * every step "skipped". Guards the last active org-wide identity:admin (mirrors
   * updateUser) so a退任 can never lock the org out of its own RBAC console.
   */
  async offboardUser(userId: string, orgId: string, ctx: RequestCtx): Promise<OffboardUserResult> {
    const user = await this.d.repo.getUser(userId);
    if (!user || user.orgId !== orgId) throw errors.notFound("user", userId);

    // last-admin guard: only fires while the target is still an ACTIVE sole admin
    // (usersWithOrgWidePermission counts active only), so an idempotent re-run is fine.
    const admins = await this.d.repo.usersWithOrgWidePermission(orgId, ADMIN);
    if (admins.length === 1 && admins[0] === userId) {
      throw errors.conflict("cannot offboard the last identity:admin holder", { code: "LAST_ADMIN" });
    }

    const alreadyDisabled = user.status !== "active";
    const steps: OffboardStepResult[] = [];

    // 1) revoke sessions — fail-close. Skip when already disabled (no live sessions to cut,
    // and the account cannot re-auth). If the revoker throws, abort before any mutation.
    if (alreadyDisabled) {
      steps.push({ step: "revoke-sessions", status: "skipped", detail: "account not active" });
    } else {
      await this.d.revoker.revokeUser(userId, ctx);
      steps.push({ step: "revoke-sessions", status: "done" });
    }

    // 2) strip all role assignments (org-wide + resource-scoped).
    const assignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    for (const a of assignments) await this.d.repo.deleteAssignment(a.id);
    steps.push(
      assignments.length > 0
        ? { step: "revoke-roles", status: "done", detail: String(assignments.length) }
        : { step: "revoke-roles", status: "skipped", detail: "0" },
    );

    // 3) disable the account.
    if (alreadyDisabled) {
      steps.push({ step: "disable-account", status: "skipped", detail: user.status });
    } else {
      await this.d.repo.updateUser(userId, { status: "disabled" }, this.d.now());
      steps.push({ step: "disable-account", status: "done" });
    }

    await this.d.audit.publish(
      this.record("identity.user.offboarded", "success", ctx, orgId, "user", userId, {
        revokedAssignments: assignments.length,
        alreadyDisabled,
      }),
    );

    const updated = (await this.d.repo.getUser(userId))!;
    const finalAssignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    return {
      user: this.toIdentityUser(updated, finalAssignments),
      revokedAssignments: assignments.length,
      alreadyDisabled,
      steps,
    };
  }

  // ---------- Email Routing sync ----------
  /**
   * Reconcile the roster against the Cloudflare Email Routing @developershub.jp
   * addresses (relayed by the caller, who holds mail:admin). Upsert-by-email:
   *  - a new address becomes an active roster row (source='email-routing');
   *  - an existing email is marked source='email-routing' (and a row WE previously
   *    deactivated is reactivated when the address re-appears enabled);
   *  - a source='email-routing' row whose address vanished is logically DISABLED,
   *    never hard-deleted (data保全) — its roles/history survive a re-sync.
   * All addresses are validated before any write, so a bad address aborts cleanly
   * with no partial mutation. Synchronous D1 upsert; independent of the freeq drain.
   */
  /** Normalize + de-dupe incoming Email Routing addresses (shared by preview + sync).
   *  Throws on a bad address before any caller does work (fail-fast, no partial state). */
  private normalizeRoutingAddresses(req: SyncEmailRoutingRequest): { email: string; enabled: boolean }[] {
    if (!req || !Array.isArray(req.addresses)) {
      throw errors.validationFailed([{ field: "addresses", reason: "required" }]);
    }
    const seen = new Set<string>();
    const out: { email: string; enabled: boolean }[] = [];
    for (const a of req.addresses) {
      const email = requireEmail(a?.address ?? "");
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({ email, enabled: a?.enabled !== false });
    }
    return out;
  }

  /**
   * #5: READ-ONLY diff of what syncEmailRouting would change — the console shows this and
   * requires an explicit apply. Mirrors the apply's reconciliation exactly (upsert-by-email
   * + logical deactivation of owned rows that vanished, admin-guarded) but performs NO
   * writes. `projected` is the SyncEmailRoutingResult the apply is expected to return.
   */
  async previewEmailRouting(orgId: string, req: SyncEmailRoutingRequest): Promise<EmailRoutingSyncPreview> {
    const org = await this.d.repo.getOrg(orgId);
    if (!org) throw errors.notFound("org", orgId);
    const normalized = this.normalizeRoutingAddresses(req);
    const seen = new Set(normalized.map((n) => n.email.toLowerCase()));

    const toAdd: EmailRoutingDiffRow[] = [];
    const toReactivate: EmailRoutingDiffRow[] = [];
    const toRelink: EmailRoutingDiffRow[] = [];
    let updated = 0;
    for (const { email, enabled } of normalized) {
      const existing = await this.d.repo.getUserByEmail(orgId, email);
      if (!existing) {
        toAdd.push({ email, enabled });
        continue;
      }
      updated++; // apply marks every existing matched row source=email-routing
      if (enabled && existing.status === "disabled" && existing.source === "email-routing") {
        toReactivate.push({ email, userId: existing.id, enabled });
      } else if (existing.source !== "email-routing") {
        toRelink.push({ email, userId: existing.id });
      }
    }

    const toDeactivate: EmailRoutingDiffRow[] = [];
    const adminKept: EmailRoutingDiffRow[] = [];
    const admins = new Set(await this.d.repo.usersWithOrgWidePermission(orgId, ADMIN));
    const owned = await this.d.repo.listUsersBySource(orgId, "email-routing");
    for (const u of owned) {
      if (seen.has(u.email.toLowerCase()) || u.status === "disabled") continue;
      if (admins.has(u.id)) adminKept.push({ email: u.email, userId: u.id });
      else toDeactivate.push({ email: u.email, userId: u.id });
    }

    return {
      toAdd,
      toReactivate,
      toRelink,
      toDeactivate,
      adminKept,
      projected: { added: toAdd.length, updated, deactivated: toDeactivate.length, total: normalized.length },
    };
  }

  async syncEmailRouting(orgId: string, req: SyncEmailRoutingRequest, ctx: RequestCtx): Promise<SyncEmailRoutingResult> {
    const org = await this.d.repo.getOrg(orgId);
    if (!org) throw errors.notFound("org", orgId);
    if (!req || !Array.isArray(req.addresses)) {
      throw errors.validationFailed([{ field: "addresses", reason: "required" }]);
    }

    // Validate + normalize up front (throws before any write on a bad address).
    const seen = new Set<string>();
    const normalized: { email: string; enabled: boolean }[] = [];
    for (const a of req.addresses) {
      const email = requireEmail(a?.address ?? "");
      if (seen.has(email)) continue; // de-dupe within the batch
      seen.add(email);
      normalized.push({ email, enabled: a?.enabled !== false });
    }

    const now = this.d.now();
    let added = 0;
    let updated = 0;
    for (const { email, enabled } of normalized) {
      const existing = await this.d.repo.getUserByEmail(orgId, email);
      if (!existing) {
        await this.d.repo.createUser({
          id: this.d.newId("user"),
          orgId,
          email,
          displayName: email.split("@")[0]!,
          githubLogin: null,
          avatarUrl: null,
          status: enabled ? "active" : "disabled",
          source: "email-routing",
          createdAt: now,
          updatedAt: now,
        });
        added++;
      } else {
        const patch: Partial<Pick<UserRow, "status" | "source">> = { source: "email-routing" };
        // re-appearing address: reactivate a row this sync had itself disabled.
        if (enabled && existing.status === "disabled" && existing.source === "email-routing") {
          patch.status = "active";
        }
        await this.d.repo.updateUser(existing.id, patch, now);
        updated++;
      }
    }

    // Logical deactivation of rows we own that are no longer in Email Routing.
    // Never auto-disable an org-wide identity:admin holder: a mailbox sync must not
    // be able to lock the org out of its own RBAC console (mirrors updateUser's guard).
    let deactivated = 0;
    const admins = new Set(await this.d.repo.usersWithOrgWidePermission(orgId, ADMIN));
    const owned = await this.d.repo.listUsersBySource(orgId, "email-routing");
    for (const u of owned) {
      if (seen.has(u.email.toLowerCase()) || u.status === "disabled" || admins.has(u.id)) continue;
      await this.d.repo.updateUser(u.id, { status: "disabled" }, now);
      deactivated++;
    }

    const result: SyncEmailRoutingResult = { added, updated, deactivated, total: normalized.length };
    await this.d.audit.publish(this.record("identity.roster.synced", "success", ctx, orgId, "org", orgId, { ...result }));
    return result;
  }

  // ---------- roles ----------
  async listRoles(orgId: string, limit?: number, cursor?: string): Promise<common.Paginated<RoleWithMemberCount>> {
    const page = await this.d.repo.listRoles(orgId, clampLimit(limit), cursor);
    const counts = await this.d.repo.roleMemberCounts(orgId);
    return {
      items: page.items.map((r) => ({ ...this.toRole(r), memberCount: counts.get(r.id) ?? 0 })),
      nextCursor: page.nextCursor,
    };
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
    // Self-lockout guard: the built-in admin role must always retain identity:admin,
    // otherwise an admin could strip role-management from every account and lock the
    // whole org out. All other permissions on any role (system or custom) stay editable.
    if (
      req.permissions !== undefined &&
      role.isSystem &&
      role.name === "admin" &&
      !req.permissions.includes(ADMIN)
    ) {
      throw errors.conflict("cannot remove identity:admin from the admin role", { code: "LAST_ADMIN" });
    }
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
  /** A user's role assignments (org + resource-scoped), with the role name joined in. */
  async listUserRoles(userId: string, orgId: string): Promise<RoleAssignmentView[]> {
    const user = await this.d.repo.getUser(userId);
    if (!user || user.orgId !== orgId) throw errors.notFound("user", userId);
    const assignments = await this.d.repo.listAssignmentsByUser(userId, orgId);
    const nameCache = new Map<string, string>();
    const out: RoleAssignmentView[] = [];
    for (const a of assignments) {
      let roleName = nameCache.get(a.roleId);
      if (roleName === undefined) {
        const role = await this.d.repo.getRole(a.roleId);
        roleName = role?.name ?? a.roleId; // orphan-safe: fall back to the id
        nameCache.set(a.roleId, roleName);
      }
      out.push(this.toAssignmentView(a, roleName));
    }
    return out;
  }

  async assignRole(userId: string, orgId: string, req: AssignRoleRequest, ctx: RequestCtx): Promise<RoleAssignmentView> {
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
    return this.toAssignmentView(assignment, role.name);
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
