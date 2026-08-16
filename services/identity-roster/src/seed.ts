// Reference-data seed: the default org + the system roles (admin / maintainer /
// organizer / member). Idempotent. Demo USERS are #28 seedDemo's job (kept out of
// here so no demo rows leak into prod). Role permission bundles are an α-decision.
import { identity } from "@dub/types";
import type { IdentityRepo } from "./repo/types";

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
  "chat:create", "chat:moderate",
  "infra:read", "infra:deploy",
  "audit:read",
  "github:read", "github:write", "github:sync",
  "drive:read", "drive:write",
  "webhook:read",
];

const SYSTEM_ROLES: { name: string; permissions: identity.PermissionKey[] }[] = [
  { name: "admin", permissions: ALL_KEYS() },
  {
    name: "maintainer",
    permissions: MAINTAINER_KEYS,
  },
  {
    name: "organizer",
    permissions: ["identity:read", "event:read", "event:write", "event:admin", "task:read", "task:write", "task:delete", "file:read", "file:write", "notif:send", "chat:create", "infra:read", "audit:read"],
  },
  {
    name: "member",
    permissions: ["identity:read", "event:read", "task:read", "task:write", "file:read", "file:write", "chat:create"],
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
