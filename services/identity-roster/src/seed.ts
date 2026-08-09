// Reference-data seed: the default org + the 3 system roles (admin/organizer/
// member). Idempotent. Demo USERS are #28 seedDemo's job (kept out of here so no
// demo rows leak into prod). Role permission bundles are an α-decision (§3 seed).
import type { identity } from "@dub/types";
import type { IdentityRepo } from "./repo/types";

const ALL_KEYS = (): identity.PermissionKey[] => (
  // full catalog; admin is genuinely all-powerful in P0
  ["identity:read", "identity:admin", "event:read", "event:write", "event:admin", "task:read", "task:write", "task:delete", "file:read", "file:write", "file:admin", "notif:send", "notif:admin", "mail:send", "mail:read", "mail:admin", "chat:create", "chat:moderate", "infra:read", "infra:deploy", "infra:dns", "infra:admin", "audit:read"]
);

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
