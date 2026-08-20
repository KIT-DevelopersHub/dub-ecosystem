// Shared in-memory fakes for drive-share-service unit tests. No network, no real bindings.
import type { PermissionChecker, DrivePermission } from "../src/permissions";
import type { RoleMembership } from "../src/role-membership";
import { createRoleGrantsService, type RoleGrantsService } from "../src/role-grants-service";
import { createInMemoryRoleGrantStore, type RoleGrantStore } from "../src/role-grants-store";
import type { DriveShareClient } from "../src/drive-client";
import { common } from "@dub/types";

/** fake PermissionChecker driven by a rule(userId, perm) => allowed. */
export function memAuthz(rule: (userId: string, perm: DrivePermission) => boolean): PermissionChecker {
  return {
    async check(userId, _orgId, permission) {
      return rule(userId, permission);
    },
  };
}

export const allowAll = memAuthz(() => true);
export const AUTHED = { "x-dub-user-id": "usr_1" };

/** Fake role membership: static role->emails and role->name maps. Emails are lowercased
 *  to mirror the real client's normalisation. */
export function fakeRoster(
  members: Record<string, string[]>,
  names: Record<string, string> = {},
): RoleMembership {
  return {
    async listActiveEmails(roleId: string): Promise<string[]> {
      const emails = members[roleId] ?? [];
      return [...new Set(emails.map((e) => e.trim().toLowerCase()))];
    },
    async roleName(roleId: string): Promise<string | null> {
      return names[roleId] ?? null;
    },
  };
}

let idSeq = 0;
let clock = 0;

/** Wire a RoleGrantsService over the mock Drive client + a fake roster + in-memory store. */
export function buildRoleGrants(opts: {
  drive: DriveShareClient;
  roster: RoleMembership;
  store?: RoleGrantStore;
}): { service: RoleGrantsService; store: RoleGrantStore } {
  const store = opts.store ?? createInMemoryRoleGrantStore();
  const service = createRoleGrantsService({
    drive: opts.drive,
    roster: opts.roster,
    store,
    orgId: common.DUB_DEFAULT_ORG_ID,
    now: () => `2026-08-13T00:00:${String(clock++ % 60).padStart(2, "0")}.000Z`,
    newId: () => `dsg_test_${++idSeq}`,
  });
  return { service, store };
}
