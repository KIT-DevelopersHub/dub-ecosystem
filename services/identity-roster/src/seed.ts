// Reference-data seed: the default org + the system roles (admin / maintainer /
// organizer / member). Idempotent. Demo USERS are #28 seedDemo's job (kept out of
// here so no demo rows leak into prod). Role permission bundles are an α-decision.
import { identity, appRegistry } from "@dub/types";
import type { IdentityRepo } from "./repo/types";

type PermissionKey = identity.PermissionKey;

// ── per-app access backfill policy (non-breaking rollout) ─────────────────────
// Opening/using an app is now gated on its own `app:<id>:view` / `app:<id>:edit` key
// (shell launcher + route guard). To ensure NOBODY loses access when this ships, every
// role is granted the per-app keys equivalent to what it can ALREADY do today, derived
// from its current DOMAIN permissions: `view` iff the role can currently reach the app
// (holds the app's read/primary perm, or the app is open to all authenticated users),
// `edit` iff it currently holds the app's write perm. Additive + idempotent (union). The
// admin system role is granted ALL per-app keys unconditionally (it is all-powerful).
interface AppAccessRule {
  id: string;
  read?: PermissionKey; // holding this ⇒ can currently open the app ⇒ grant view
  write?: PermissionKey; // holding this ⇒ can currently edit in the app ⇒ grant edit
  openToAll?: boolean; // launcher tile open to any authenticated user ⇒ grant view to all
}
const APP_ACCESS_RULES: AppAccessRule[] = [
  { id: "events", read: "event:read", write: "event:write" },
  { id: "tasks", read: "task:read", write: "task:write" },
  { id: "gantt", read: "task:read", write: "task:write" },
  { id: "notifications", read: "notif:inbox:self" },
  { id: "chat", read: "chat:create", write: "chat:moderate" },
  { id: "mail", read: "mail:read", write: "mail:send" },
  { id: "usage", openToAll: true },
  { id: "members", read: "identity:read", write: "identity:admin" },
  { id: "participation", openToAll: true, write: "identity:admin" },
  { id: "driveshare", openToAll: true, write: "drive:write" },
  { id: "admin", read: "identity:admin", write: "identity:admin" },
];

/** The per-app access keys a role should hold given its current domain permissions
 *  (edit co-carries view). Pure; used for both fresh seeds and the backfill. */
export function computeAppAccessKeys(perms: readonly PermissionKey[]): PermissionKey[] {
  const has = new Set(perms);
  const out = new Set<PermissionKey>();
  for (const rule of APP_ACCESS_RULES) {
    const view = appRegistry.appViewKey(rule.id);
    const edit = appRegistry.appEditKey(rule.id);
    if (!view || !edit) continue;
    const canEdit = rule.write !== undefined && has.has(rule.write);
    const canView = rule.openToAll === true || (rule.read !== undefined && has.has(rule.read)) || canEdit;
    if (canView) out.add(view);
    if (canEdit) out.add(edit);
  }
  return [...out];
}

/** A role's base (domain) permission bundle plus its computed per-app access keys. */
function withAppAccess(base: PermissionKey[]): PermissionKey[] {
  return [...new Set([...base, ...computeAppAccessKeys(base)])];
}

// admin is genuinely all-powerful in P0: derive every key from the frozen
// catalog so a catalog change (e.g. github:* / drive:* / webhook:read) can never
// silently drop admin below full coverage (drift-proof, see seed test).
const ALL_KEYS = (): identity.PermissionKey[] =>
  identity.PERMISSION_CATALOG.map((e) => e.key);

// maintainer sits between admin and member: full operational + editing power, but
// NO org administration — cannot change identity/roles/member permissions
// (identity:admin), org infra settings (infra:admin/infra:dns), or the
// integration/mail admin surfaces. Deliberately extensible (future viewer/owner
// slot in cleanly by adding another SYSTEM_ROLES entry).
const MAINTAINER_KEYS: identity.PermissionKey[] = [
  "identity:read",
  "event:read", "event:write", "event:admin",
  "task:read", "task:write", "task:delete",
  "file:read", "file:write",
  "notif:send", "notif:admin", "notif:broadcast_publish",
  "mail:send", "mail:read",
  "chat:create", "chat:delete", "chat:moderate",
  "usage:view",
  "infra:read", "infra:deploy",
  "audit:read",
  "github:read", "github:write", "github:sync",
  "drive:read", "drive:write",
  "webhook:read",
];

// ALL_KEYS() already includes every per-app access key (they live in the catalog), so
// admin is fully covered; the other tiers get their per-app keys computed from their
// domain bundle via withAppAccess (non-breaking: they can reach today exactly what they
// could before, now expressed as explicit per-app toggles).
const SYSTEM_ROLES: { name: string; permissions: identity.PermissionKey[] }[] = [
  { name: "admin", permissions: ALL_KEYS() },
  {
    name: "maintainer",
    permissions: withAppAccess(MAINTAINER_KEYS),
  },
  {
    name: "organizer",
    permissions: withAppAccess(["identity:read", "event:read", "event:write", "event:admin", "task:read", "task:write", "task:delete", "file:read", "file:write", "notif:send", "chat:create", "chat:delete", "usage:view", "infra:read", "audit:read"]),
  },
  {
    name: "member",
    permissions: withAppAccess(["identity:read", "event:read", "task:read", "task:write", "file:read", "file:write", "chat:create", "chat:delete", "usage:view"]),
  },
];

export interface SeedDeps {
  repo: IdentityRepo;
  now: () => string;
  newId: (prefix: string) => string;
}

export async function seedReferenceData(d: SeedDeps, orgId: string, orgName = "DevHub"): Promise<void> {
  if (!(await d.repo.getOrg(orgId))) {
    await d.repo.createOrg({ id: orgId, name: orgName, createdAt: d.now() });
  }
  for (const sr of SYSTEM_ROLES) {
    if (await d.repo.getRoleByName(orgId, sr.name)) continue;
    const now = d.now();
    await d.repo.createRole({ id: d.newId("role"), orgId, name: sr.name, isSystem: true, permissions: sr.permissions, createdAt: now, updatedAt: now });
  }
  // Backfill the per-app access keys onto EXISTING roles (created before this change) so
  // the new gate never removes access a role already has. Runs on every seed (idempotent).
  await backfillAppAccessKeys(d, orgId);
  // Backfill chat:delete onto EXISTING chat-capable roles: deleting one's OWN message is
  // now gated on chat:delete (was universal for authors). Granting it to every role that
  // can already use chat preserves that ability so nobody loses own-delete on rollout.
  await backfillChatDelete(d, orgId);
}

/**
 * Idempotent, additive backfill for the new `chat:delete` gate. Deleting your OWN chat
 * message used to be universal (any author); it is now gated on `chat:delete`. Grant it
 * to every role that can already reach chat (holds `chat:create` or an `app:chat` key, or
 * is the admin role) so the rollout removes nobody's existing own-delete ability. Only
 * writes roles whose set changes → re-running is a no-op. MUST run before / with the
 * chat-service gate deploy on the production rollout path.
 * @returns the names of roles that were updated (empty when already up to date).
 */
export async function backfillChatDelete(d: SeedDeps, orgId: string): Promise<string[]> {
  const chatView = appRegistry.appViewKey("chat");
  const chatEdit = appRegistry.appEditKey("chat");
  const updated: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await d.repo.listRoles(orgId, 100, cursor);
    for (const role of page.items) {
      const cur = new Set(role.permissions as PermissionKey[]);
      if (cur.has("chat:delete")) continue;
      const canUseChat =
        (role.isSystem && role.name === "admin") ||
        cur.has("chat:create") ||
        cur.has("chat:moderate") ||
        (chatView !== undefined && cur.has(chatView)) ||
        (chatEdit !== undefined && cur.has(chatEdit));
      if (!canUseChat) continue;
      cur.add("chat:delete");
      await d.repo.updateRolePermissions(role.id, undefined, [...cur], d.now());
      updated.push(role.name);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return updated;
}

/**
 * Idempotent, additive backfill: ensure every role holds the per-app access keys implied
 * by its current domain permissions (admin system role ⇒ ALL per-app keys). Only writes a
 * role whose set actually changes, so re-running is a no-op. Safe to call standalone during
 * a deploy (the production rollout path for the per-app gate).
 * @returns the names of roles that were updated (empty when already up to date).
 */
export async function backfillAppAccessKeys(d: SeedDeps, orgId: string): Promise<string[]> {
  const updated: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await d.repo.listRoles(orgId, 100, cursor);
    for (const role of page.items) {
      const current = new Set(role.permissions as PermissionKey[]);
      const grant =
        role.isSystem && role.name === "admin"
          ? appRegistry.allAppAccessKeys()
          : computeAppAccessKeys(role.permissions as PermissionKey[]);
      const missing = grant.filter((k) => !current.has(k));
      if (missing.length === 0) continue;
      const next = [...current, ...missing];
      await d.repo.updateRolePermissions(role.id, undefined, next, d.now());
      updated.push(role.name);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return updated;
}

// ---- demo users -------------------------------------------------------------
// Three active accounts for driving the ecosystem without Google, one per system
// role (admin / maintainer / member). Company-domain emails so they pass the
// auth-service domain gate (ALLOWED_LOGIN_DOMAIN=developershub.jp). Kept OUT of the
// migration seed on purpose so no demo rows leak into a real deployment; a deploy
// opts in by calling seedDemoUsers explicitly. The matching password credentials
// live in auth-service KV (auth-service seedDemoCredentials / seedPasswordCredential).
export interface DemoUserSpec {
  email: string;
  displayName: string;
  roleName: "admin" | "maintainer" | "member";
}
export const DEMO_USERS: readonly DemoUserSpec[] = [
  { email: "admin@developershub.jp", displayName: "Demo Admin", roleName: "admin" },
  { email: "maintainer@developershub.jp", displayName: "Demo Maintainer", roleName: "maintainer" },
  { email: "member@developershub.jp", displayName: "Demo Member", roleName: "member" },
] as const;

export interface SeededDemoUser {
  email: string;
  userId: string;
  roleName: string;
}

/** Idempotent: ensure each spec exists as an active user with an org-wide assignment of
 *  its role. Shared by seedDemoUsers and seedOversightUsers so both use the identical
 *  create-if-absent / assign-if-absent path. Re-running never duplicates. */
async function seedUsersWithRole(d: SeedDeps, orgId: string, specs: readonly DemoUserSpec[]): Promise<SeededDemoUser[]> {
  await seedReferenceData(d, orgId);
  const out: SeededDemoUser[] = [];
  for (const spec of specs) {
    const email = spec.email.toLowerCase();
    let user = await d.repo.getUserByEmail(orgId, email);
    if (!user) {
      const now = d.now();
      user = {
        id: d.newId("user"),
        orgId,
        email,
        displayName: spec.displayName,
        githubLogin: null,
        avatarUrl: null,
        status: "active",
        source: "manual",
        createdAt: now,
        updatedAt: now,
      };
      await d.repo.createUser(user);
    }
    const role = await d.repo.getRoleByName(orgId, spec.roleName);
    if (role && !(await d.repo.findAssignment(user.id, role.id, orgId, null, null))) {
      const now = d.now();
      await d.repo.createAssignment({
        id: d.newId("ra"),
        userId: user.id,
        roleId: role.id,
        orgId,
        resourceType: null,
        resourceId: null,
        grantedBy: user.id,
        grantedAt: now,
      });
    }
    out.push({ email, userId: user.id, roleName: spec.roleName });
  }
  return out;
}

/** Idempotent: create the demo org + roles, then the 3 demo users with an org-wide
 *  role assignment each. Re-running never duplicates users or assignments. */
export async function seedDemoUsers(d: SeedDeps, orgId: string): Promise<SeededDemoUser[]> {
  return seedUsersWithRole(d, orgId, DEMO_USERS);
}

// ---- oversight accounts (info@ / admin@) ------------------------------------
// The two shared DevHub addresses are modeled as INDIVIDUAL real users (not a shared-
// mailbox concept): each is one loginable account (a company-domain email => passes the
// auth-service allowlist domain gate) carrying the admin role, so it holds mail:read_all
// and can view EVERY user's mail (oversight). Personal @developershub.jp accounts keep
// their own-mail scope. admin@ overlaps the admin DEMO_USER; getUserByEmail keeps it one
// row, so seeding both sets is safe.
export const OVERSIGHT_USERS: readonly DemoUserSpec[] = [
  { email: "info@developershub.jp", displayName: "Info (DevHub)", roleName: "admin" },
  { email: "admin@developershub.jp", displayName: "Admin (DevHub)", roleName: "admin" },
] as const;

/** Idempotent: seed the info@ / admin@ oversight accounts as individual admin-role users
 *  (=> mail:read_all). Re-running never duplicates users or assignments. */
export async function seedOversightUsers(d: SeedDeps, orgId: string): Promise<SeededDemoUser[]> {
  return seedUsersWithRole(d, orgId, OVERSIGHT_USERS);
}
