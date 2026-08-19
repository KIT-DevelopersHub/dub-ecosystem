// In-memory ResourceClient implementing the identity/audit contract surface.
// Powers the standalone dev harness and component/E2E tests (design §5: "P1
// 実装時の依存先はモックサーバ(契約準拠スタブ)"). NOT shipped to production —
// FE2 provides the real ResourceClient there.
import { identity, chat } from "@dub/types"; // value import: identity.PERMISSION_CATALOG + chat.DEFAULT_MESSAGE_DELETION_POLICY
import type { common, auditLog, gateway, member } from "@dub/types";
import type { ResourceClient, ErrorResponse } from "../shell/contract";
import type { RoleAssignment, EmailRoutingAddress, UserSource, SyncEmailRoutingResult, OffboardUserResult, EmailRoutingSyncPreview } from "../contracts/pending";
import { EMAIL_ROUTING_DOMAIN } from "../contracts/pending";

// Mock roster row: the frozen detail model plus provenance (identity-roster exposes it).
type MockUser = identity.IdentityUserDetail & { source: UserSource };
import { CLEAR_MAIL_RATE_LIMIT, type MailRateLimitStatus, type MailStatusResponse } from "../lib/mailStatus";

function err(code: string, message: string, details?: unknown): ErrorResponse {
  return { error: { code, message, retryable: false, ...(details !== undefined ? { details } : {}) } };
}

const now = () => new Date().toISOString();

export interface MockSeed {
  me?: gateway.MeResponse;
  /** Seed the /api/v1/mail/status rate-limit view (default: not limited). */
  mailRateLimit?: MailRateLimitStatus;
}

interface MockState {
  users: Map<string, MockUser>;
  roles: Map<string, identity.Role>;
  assignments: Map<string, RoleAssignment[]>; // userId -> assignments
  audits: auditLog.AuditRecord[];
  emailAddresses: EmailRoutingAddress[];
  members: member.Member[]; // 運営メンバー (member-service) — for #1/#2 link + offboard
  me: gateway.MeResponse;
  mailRateLimit: MailRateLimitStatus;
  // userId -> current plaintext password (admin set/view surface, #5a/#5c). The real
  // backend stores an AES copy; the mock keeps the plaintext so the view flow works.
  passwords: Map<string, string>;
}

const ORG = "org_devhub";

function seedState(seed?: MockSeed): MockState {
  const roles = new Map<string, identity.Role>([
    ["role_admin", { id: "role_admin", orgId: ORG, name: "admin", permissions: ["identity:read", "identity:admin", "audit:read", "event:read", "mail:admin"], isSystem: true }],
    // member carries chat access + own-delete so the standalone shows the チャット row's
    // 削除権限=削除あり + 挙動 toggle (RoleListPage count tests key off admin=5 / organizer=2,
    // so those two stay at their original bundles).
    ["role_member", { id: "role_member", orgId: ORG, name: "member", permissions: ["identity:read", "event:read", "chat:create", "chat:delete", "app:chat:view"], isSystem: true }],
    ["role_organizer", { id: "role_organizer", orgId: ORG, name: "organizer", permissions: ["event:read", "event:write"], isSystem: false }],
  ]);
  const users = new Map<string, MockUser>([
    ["user_alice", { id: "user_alice", orgId: ORG, displayName: "Alice Admin", email: "alice@developershub.jp", githubLogin: "alice", avatarUrl: null, status: "active", source: "manual", roleIds: ["role_admin"], permissions: ["identity:read", "identity:admin", "audit:read", "event:read"], createdAt: now(), updatedAt: now() }],
    ["user_bob", { id: "user_bob", orgId: ORG, displayName: "Bob Member", email: "bob@developershub.jp", githubLogin: "bob", avatarUrl: null, status: "active", source: "manual", roleIds: ["role_member"], permissions: ["identity:read", "event:read"], createdAt: now(), updatedAt: now() }],
    ["user_carol", { id: "user_carol", orgId: ORG, displayName: "Carol Invited", email: "carol@developershub.jp", githubLogin: null, avatarUrl: null, status: "invited", source: "manual", roleIds: [], permissions: [], createdAt: now(), updatedAt: now() }],
  ]);
  const assignments = new Map<string, RoleAssignment[]>([
    ["user_alice", [{ id: "asg_1", userId: "user_alice", roleId: "role_admin", roleName: "admin", resourceType: null, resourceId: null, grantedBy: "user_alice", grantedAt: now() }]],
    ["user_bob", [{ id: "asg_2", userId: "user_bob", roleId: "role_member", roleName: "member", resourceType: null, resourceId: null, grantedBy: "user_alice", grantedAt: now() }]],
  ]);
  const audits: auditLog.AuditRecord[] = [
    { id: "aud_1", action: "identity.role.assigned", actorId: "user_alice", orgId: ORG, result: "success", resourceType: "user", resourceId: "user_bob", details: { roleId: "role_member" }, requestId: "req_1", occurredAt: now(), recordedAt: now() },
  ];
  const emailAddresses: EmailRoutingAddress[] = [
    { id: "eml_1", localPart: "info", address: `info@${EMAIL_ROUTING_DOMAIN}`, destination: "staff@example.com", enabled: true, createdAt: now() },
    { id: "eml_2", localPart: "support", address: `support@${EMAIL_ROUTING_DOMAIN}`, destination: "help@example.com", enabled: true, createdAt: now() },
    { id: "eml_3", localPart: "noreply", address: `noreply@${EMAIL_ROUTING_DOMAIN}`, destination: "void@example.com", enabled: false, createdAt: now() },
    // Bob has an issued @developershub.jp address so his offboard demonstrates the删除 step.
    { id: "eml_bob", localPart: "bob", address: `bob@${EMAIL_ROUTING_DOMAIN}`, destination: "bob@example.com", enabled: true, createdAt: now() },
  ];
  // 運営メンバー: 佐藤 太郎 is linked to user_bob (#1) so退任 fans out to the org-chart.
  // 山田 花子 / 鈴木 一郎 are UNLINKED so the メール名簿「運営メンバーと紐付け」flow has candidates.
  const members: member.Member[] = [
    { id: "member_bob", orgId: ORG, name: "佐藤 太郎", roleTitle: "会場リーダー", status: "added", teamIds: [], department: null, grade: null, identityUserId: "user_bob", contact: null, note: null, sortOrder: 1024, version: 1, createdAt: now(), updatedAt: now() },
    { id: "member_hanako", orgId: ORG, name: "山田 花子", roleTitle: "広報担当", status: "added", teamIds: [], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 2048, version: 1, createdAt: now(), updatedAt: now() },
    { id: "member_ichiro", orgId: ORG, name: "鈴木 一郎", roleTitle: "開発リーダー", status: "added", teamIds: [], department: null, grade: null, identityUserId: null, contact: null, note: null, sortOrder: 3072, version: 1, createdAt: now(), updatedAt: now() },
  ];
  const me: gateway.MeResponse = seed?.me ?? {
    user: { id: "user_alice", displayName: "Alice Admin", avatarUrl: null },
    orgId: ORG,
    permissions: ["identity:read", "identity:admin", "audit:read", "event:read", "mail:admin"],
    sessionExpiresAt: Date.now() + 3600_000,
  };
  // user_alice starts with a viewable credential (demo/E2E); others are unset until an
  // admin issues one (view then rejects with PASSWORD_NOT_VIEWABLE, like the backend).
  const passwords = new Map<string, string>([["user_alice", "Alice-Init-0001"]]);
  return { users, roles, assignments, audits, emailAddresses, members, me, mailRateLimit: seed?.mailRateLimit ?? CLEAR_MAIL_RATE_LIMIT, passwords };
}

function paginate<T>(items: T[]): common.Paginated<T> {
  return { items, nextCursor: null };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Construct an in-memory client. Each call gets isolated state. */
export function createMockClient(seed?: MockSeed, latencyMs = 0): ResourceClient {
  const s = seedState(seed);
  // Dev-only: delay reads so loading/skeleton states are previewable (FRONTEND_GUIDE §5).
  const readDelay = () => (latencyMs > 0 ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  // Chat message-deletion policy (mock default = product default: all hard, version 0).
  let chatPolicy: chat.DeletionPolicyResponse = { policy: { ...chat.DEFAULT_MESSAGE_DELETION_POLICY }, version: 0 };

  async function get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    await readDelay();
    if (path.endsWith("/chat/settings/deletion-policy")) return { policy: { ...chatPolicy.policy }, version: chatPolicy.version } as unknown as T;
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
    const byIdentity = path.match(/\/members\/people\/by-identity\/([^/]+)$/);
    if (byIdentity) {
      const m = s.members.find((x) => x.identityUserId === byIdentity[1]!) ?? null;
      return { member: m } as unknown as T;
    }
    if (path.endsWith("/members/overview")) {
      // 運営メンバー overview — powers the メール名簿「運営メンバー」列 + 紐付けピッカー.
      return { teams: [], members: [...s.members] } as unknown as T;
    }
    if (path.endsWith("/admin/email-routing/roster-addresses")) {
      // roster sync source: the RECEIVING addresses (one per issued rule), not destinations.
      return {
        items: s.emailAddresses.map((a) => ({ address: a.address, destination: a.destination, enabled: a.enabled })),
      } as unknown as T;
    }
    if (path.endsWith("/admin/email-routing/addresses")) {
      return paginate([...s.emailAddresses]) as unknown as T;
    }
    if (path.endsWith("/audit/logs")) {
      const action = (query?.action as string | undefined) ?? "identity.";
      const filtered = s.audits.filter((a) => a.action.startsWith(action));
      return paginate(filtered) as unknown as T;
    }
    const viewPwMatch = path.match(/\/admin\/users\/([^/]+)\/password$/);
    if (viewPwMatch) {
      const u = s.users.get(viewPwMatch[1]!);
      if (!u) throw err("NOT_FOUND", "user not found");
      const pw = s.passwords.get(u.id);
      if (!pw) throw err("PASSWORD_NOT_VIEWABLE", "no viewable password for this user");
      return { userId: u.id, email: u.email, password: pw } as unknown as T;
    }
    if (path.endsWith("/me")) return s.me as unknown as T;
    if (path.endsWith("/mail/status")) {
      const body: MailStatusResponse = { service: "mail-gateway", provider: "resend", rateLimit: s.mailRateLimit };
      return body as unknown as T;
    }
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
      const user: MockUser = {
        id, orgId: ORG, displayName: req.displayName ?? req.email, email: req.email,
        githubLogin: null, avatarUrl: null, status: "invited", source: "manual", roleIds: req.roleIds ?? [],
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
      // Keep the denormalized user.roleIds in sync for ORG-WIDE grants so the roster
      // list's ロール column stays truthful after an inline edit (event-scoped grants
      // are not org roles and never touch roleIds).
      if (asg.resourceType === null) {
        const u = s.users.get(userId);
        if (u && !u.roleIds.includes(asg.roleId)) {
          s.users.set(userId, { ...u, roleIds: [...u.roleIds, asg.roleId], updatedAt: now() });
        }
      }
      return asg as unknown as T;
    }
    if (path.endsWith("/users/sync-email-routing/preview")) {
      const req = body as { addresses?: Array<{ address: string; enabled?: boolean }> };
      const list = Array.isArray(req?.addresses) ? req.addresses : [];
      const seen = new Set<string>();
      const normalized: { email: string; enabled: boolean }[] = [];
      for (const a of list) {
        const email = (a?.address ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(email)) throw err("VALIDATION_FAILED", "invalid address", [{ field: "address", reason: "format", message: email }]);
        if (seen.has(email)) continue;
        seen.add(email);
        normalized.push({ email, enabled: a?.enabled !== false });
      }
      const toAdd: EmailRoutingSyncPreview["toAdd"] = [];
      const toReactivate: EmailRoutingSyncPreview["toReactivate"] = [];
      const toRelink: EmailRoutingSyncPreview["toRelink"] = [];
      let updated = 0;
      for (const { email, enabled } of normalized) {
        const existing = [...s.users.values()].find((u) => u.email.toLowerCase() === email);
        if (!existing) { toAdd.push({ email, enabled }); continue; }
        updated++;
        if (enabled && existing.status === "disabled" && existing.source === "email-routing") toReactivate.push({ email, userId: existing.id, enabled });
        else if (existing.source !== "email-routing") toRelink.push({ email, userId: existing.id });
      }
      const adminRoleIds = new Set([...s.roles.values()].filter((r) => r.permissions.includes("identity:admin")).map((r) => r.id));
      const isAdmin = (uid: string) => (s.assignments.get(uid) ?? []).some((a) => a.resourceType === null && adminRoleIds.has(a.roleId));
      const toDeactivate: EmailRoutingSyncPreview["toDeactivate"] = [];
      const adminKept: EmailRoutingSyncPreview["adminKept"] = [];
      for (const u of [...s.users.values()]) {
        if (u.source !== "email-routing" || u.status === "disabled") continue;
        if (seen.has(u.email.toLowerCase())) continue;
        if (isAdmin(u.id)) adminKept.push({ email: u.email, userId: u.id });
        else toDeactivate.push({ email: u.email, userId: u.id });
      }
      const result: EmailRoutingSyncPreview = {
        toAdd, toReactivate, toRelink, toDeactivate, adminKept,
        projected: { added: toAdd.length, updated, deactivated: toDeactivate.length, total: normalized.length },
      };
      return result as unknown as T;
    }
    if (path.endsWith("/users/sync-email-routing")) {
      const req = body as { addresses?: Array<{ address: string; enabled?: boolean }> };
      const list = Array.isArray(req?.addresses) ? req.addresses : [];
      // validate + normalize up front (bad address aborts with nothing written)
      const seen = new Set<string>();
      const normalized: { email: string; enabled: boolean }[] = [];
      for (const a of list) {
        const email = (a?.address ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(email)) {
          throw err("VALIDATION_FAILED", "invalid address", [{ field: "address", reason: "format", message: email }]);
        }
        if (seen.has(email)) continue;
        seen.add(email);
        normalized.push({ email, enabled: a?.enabled !== false });
      }
      let added = 0;
      let updated = 0;
      for (const { email, enabled } of normalized) {
        const existing = [...s.users.values()].find((u) => u.email.toLowerCase() === email);
        if (!existing) {
          const id = `user_${Math.random().toString(36).slice(2, 8)}`;
          s.users.set(id, {
            id, orgId: ORG, displayName: email.split("@")[0]!, email,
            githubLogin: null, avatarUrl: null, status: enabled ? "active" : "disabled",
            source: "email-routing", roleIds: [], permissions: [], createdAt: now(), updatedAt: now(),
          });
          added++;
        } else {
          const reactivate = enabled && existing.status === "disabled" && existing.source === "email-routing";
          s.users.set(existing.id, { ...existing, source: "email-routing", ...(reactivate ? { status: "active" } : {}), updatedAt: now() });
          updated++;
        }
      }
      let deactivated = 0;
      for (const u of [...s.users.values()]) {
        if (u.source !== "email-routing" || u.status === "disabled") continue;
        if (seen.has(u.email.toLowerCase())) continue;
        s.users.set(u.id, { ...u, status: "disabled", updatedAt: now() });
        deactivated++;
      }
      const result: SyncEmailRoutingResult = { added, updated, deactivated, total: normalized.length };
      return result as unknown as T;
    }
    if (path.endsWith("/admin/email-routing/addresses")) {
      const req = body as { localPart: string; destination: string };
      const localPart = req.localPart?.trim().toLowerCase();
      if (!localPart || !/^[a-z0-9._-]+$/.test(localPart)) {
        throw err("VALIDATION_FAILED", "invalid local part", [{ field: "localPart", reason: "format" }]);
      }
      if (!EMAIL_RE.test(req.destination ?? "")) {
        throw err("VALIDATION_FAILED", "invalid destination", [{ field: "destination", reason: "format" }]);
      }
      if (s.emailAddresses.some((a) => a.localPart === localPart)) throw err("CONFLICT", "address already exists");
      const addr: EmailRoutingAddress = {
        id: `eml_${Math.random().toString(36).slice(2, 8)}`,
        localPart,
        address: `${localPart}@${EMAIL_ROUTING_DOMAIN}`,
        destination: req.destination,
        enabled: true,
        createdAt: now(),
      };
      s.emailAddresses.push(addr);
      return addr as unknown as T;
    }
    const linkMatch = path.match(/\/members\/people\/([^/]+)\/identity-link$/);
    if (linkMatch) {
      const idx = s.members.findIndex((m) => m.id === linkMatch[1]!);
      if (idx === -1) throw err("NOT_FOUND", "member not found");
      const cur = s.members[idx]!;
      const req = (body ?? {}) as { identityUserId?: string | null; version?: number };
      if (typeof req.version !== "number") {
        throw err("VALIDATION_FAILED", "version required", [{ field: "version", reason: "required" }]);
      }
      if (req.version !== cur.version) throw err("MEMBER_VERSION_CONFLICT", "version conflict");
      const target = req.identityUserId ?? null;
      if (target) {
        // 1:1 guard mirrors member-service resolveIdentityLink (MEMBER_IDENTITY_ALREADY_LINKED).
        const other = s.members.find((m) => m.identityUserId === target && m.id !== cur.id);
        if (other) {
          throw err("MEMBER_IDENTITY_ALREADY_LINKED", `identity user ${target} is already linked to another member`, [
            { field: "identityUserId", reason: "already_linked", message: other.id },
          ]);
        }
      }
      const updated: member.Member = { ...cur, identityUserId: target, version: cur.version + 1, updatedAt: now() };
      s.members[idx] = updated;
      return updated as unknown as T;
    }
    const offboardMatch = path.match(/\/identity\/users\/([^/]+)\/offboard$/);
    if (offboardMatch) {
      const u = s.users.get(offboardMatch[1]!);
      if (!u) throw err("NOT_FOUND", "user not found");
      // last active org-wide admin guard (mirrors identity-roster).
      const adminRoleIds = new Set([...s.roles.values()].filter((r) => r.permissions.includes("identity:admin")).map((r) => r.id));
      const activeAdmins = [...s.users.values()].filter(
        (x) => x.status === "active" && (s.assignments.get(x.id) ?? []).some((a) => a.resourceType === null && adminRoleIds.has(a.roleId)),
      );
      if (activeAdmins.length === 1 && activeAdmins[0]!.id === u.id) {
        throw err("CONFLICT", "cannot offboard the last identity:admin holder", { code: "LAST_ADMIN" });
      }
      const alreadyDisabled = u.status !== "active";
      const assignments = s.assignments.get(u.id) ?? [];
      const steps: OffboardUserResult["steps"] = [];
      steps.push(alreadyDisabled ? { step: "revoke-sessions", status: "skipped", detail: "account not active" } : { step: "revoke-sessions", status: "done" });
      s.assignments.set(u.id, []);
      steps.push(assignments.length > 0 ? { step: "revoke-roles", status: "done", detail: String(assignments.length) } : { step: "revoke-roles", status: "skipped", detail: "0" });
      const disabled: MockUser = { ...u, status: "disabled", roleIds: [], updatedAt: now() };
      s.users.set(u.id, disabled);
      steps.push(alreadyDisabled ? { step: "disable-account", status: "skipped", detail: u.status } : { step: "disable-account", status: "done" });
      const result: OffboardUserResult = { user: stripDetail(disabled), revokedAssignments: assignments.length, alreadyDisabled, steps };
      return result as unknown as T;
    }
    const setPwMatch = path.match(/\/admin\/users\/([^/]+)\/password$/);
    if (setPwMatch) {
      const u = s.users.get(setPwMatch[1]!);
      if (!u) throw err("NOT_FOUND", "user not found");
      const req = (body ?? {}) as { password?: string; generate?: boolean };
      const supplied = typeof req.password === "string" && req.password.length > 0 ? req.password : "";
      const generated = supplied === "" || req.generate === true;
      if (!generated && supplied.length < 8) {
        throw err("VALIDATION_FAILED", "password too short", [{ field: "password", reason: "too_short", message: "min 8 chars" }]);
      }
      const password = generated ? `Pw-${Math.random().toString(36).slice(2, 10)}` : supplied;
      s.passwords.set(u.id, password);
      return (generated ? { ok: true, password } : { ok: true }) as unknown as T;
    }
    throw err("NOT_FOUND", `unhandled POST ${path}`);
  }

  async function patch<T>(path: string, body?: unknown): Promise<T> {
    if (path.endsWith("/chat/settings/deletion-policy")) {
      const req = body as chat.UpdateDeletionPolicyRequest;
      if (req.version !== chatPolicy.version) throw err("CHAT_VERSION_CONFLICT", "stale deletion-policy version");
      chatPolicy = { policy: { member: req.policy.member, moderator: req.policy.moderator, protectReacted: req.policy.protectReacted }, version: chatPolicy.version + 1 };
      return { policy: { ...chatPolicy.policy }, version: chatPolicy.version } as unknown as T;
    }
    const roleMatch = path.match(/\/identity\/roles\/([^/]+)$/);
    if (roleMatch) {
      const role = s.roles.get(roleMatch[1]!);
      if (!role) throw err("NOT_FOUND", "role not found");
      const req = body as { name?: string; permissions?: identity.PermissionKey[] };
      // Self-lockout guard (mirrors identity-roster): the admin role must keep identity:admin.
      if (role.isSystem && role.name === "admin" && req.permissions !== undefined && !req.permissions.includes("identity:admin")) {
        throw err("CONFLICT", "cannot remove identity:admin from the admin role");
      }
      const updated: identity.Role = { ...role, ...(req.name !== undefined ? { name: req.name } : {}), ...(req.permissions !== undefined ? { permissions: req.permissions } : {}) };
      s.roles.set(role.id, updated);
      return updated as unknown as T;
    }
    const userMatch = path.match(/\/identity\/users\/([^/]+)$/);
    if (userMatch) {
      const u = s.users.get(userMatch[1]!);
      if (!u) throw err("NOT_FOUND", "user not found");
      const req = body as Partial<identity.IdentityUser>;
      const updated: MockUser = { ...u, ...req, updatedAt: now() };
      s.users.set(u.id, updated);
      return stripDetail(updated) as unknown as T;
    }
    const memberMatch = path.match(/\/members\/people\/([^/]+)$/);
    if (memberMatch) {
      const idx = s.members.findIndex((m) => m.id === memberMatch[1]!);
      if (idx === -1) throw err("NOT_FOUND", "member not found");
      const cur = s.members[idx]!;
      const req = body as Partial<member.Member> & { version?: number };
      if (typeof req.version === "number" && req.version !== cur.version) throw err("MEMBER_VERSION_CONFLICT", "version conflict");
      const updated: member.Member = { ...cur, ...(req.status !== undefined ? { status: req.status } : {}), ...(req.identityUserId !== undefined ? { identityUserId: req.identityUserId } : {}), version: cur.version + 1, updatedAt: now() };
      s.members[idx] = updated;
      return updated as unknown as T;
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
      const removed = list.find((a) => a.id === asgId);
      const remaining = list.filter((a) => a.id !== asgId);
      s.assignments.set(userId!, remaining);
      // Mirror the org-wide revoke into user.roleIds (unless another org-wide
      // assignment still grants the same role).
      if (removed && removed.resourceType === null) {
        const stillOrgWide = remaining.some((a) => a.roleId === removed.roleId && a.resourceType === null);
        if (!stillOrgWide) {
          const u = s.users.get(userId!);
          if (u) s.users.set(userId!, { ...u, roleIds: u.roleIds.filter((r) => r !== removed.roleId), updatedAt: now() });
        }
      }
      return;
    }
    const emailMatch = path.match(/\/admin\/email-routing\/addresses\/([^/]+)$/);
    if (emailMatch) {
      s.emailAddresses = s.emailAddresses.filter((a) => a.id !== emailMatch[1]!);
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
