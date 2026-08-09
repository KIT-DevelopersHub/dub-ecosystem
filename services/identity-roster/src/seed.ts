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
