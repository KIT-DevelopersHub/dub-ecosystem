// Reference-data seed: the default org + the 3 system roles (admin/organizer/
// member). Idempotent. Demo USERS are #28 seedDemo's job (kept out of here so no
// demo rows leak into prod). Role permission bundles are an α-decision (§3 seed).
import { identity } from "@dub/types";
import type { IdentityRepo } from "./repo/types";

// admin is genuinely all-powerful in P0: derive every key from the frozen
// catalog so a catalog change (e.g. github:* / drive:* / webhook:read) can never
// silently drop admin below full coverage (drift-proof, see seed test).
const ALL_KEYS = (): identity.PermissionKey[] =>
  identity.PERMISSION_CATALOG.map((e) => e.key);

const SYSTEM_ROLES: { name: string; permissions: identity.PermissionKey[] }[] = [
  { name: "admin", permissions: ALL_KEYS() },
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
// Two active accounts for driving the ecosystem without Google: an admin and a
// regular member (see [[dub-client-dual-mode-toggle]] — admin vs member views).
// Kept OUT of the migration seed on purpose so no demo rows leak into a real
// deployment; a deploy opts in by calling seedDemoUsers explicitly. The matching
// password credentials live in auth-service KV (auth-service seedPasswordCredential).
export interface DemoUserSpec {
  email: string;
  displayName: string;
  roleName: "admin" | "member";
}
export const DEMO_USERS: readonly DemoUserSpec[] = [
  { email: "admin@dub.local", displayName: "Demo Admin", roleName: "admin" },
  { email: "member@dub.local", displayName: "Demo Member", roleName: "member" },
] as const;

export interface SeededDemoUser {
  email: string;
  userId: string;
  roleName: string;
}

/** Idempotent: create the demo org + roles, then the 2 demo users with an org-wide
 *  role assignment each. Re-running never duplicates users or assignments. */
export async function seedDemoUsers(d: SeedDeps, orgId: string): Promise<SeededDemoUser[]> {
  await seedReferenceData(d, orgId);
  const out: SeededDemoUser[] = [];
  for (const spec of DEMO_USERS) {
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
