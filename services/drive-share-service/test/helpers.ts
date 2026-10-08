// Shared in-memory fakes for drive-share-service unit tests. No network, no real bindings.
import type { PermissionGranter } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import type { RoleMembership } from "../src/role-membership";
import { createRoleGrantsService, type RoleGrantsService } from "../src/role-grants-service";
import { createInMemoryRoleGrantStore, type RoleGrantStore } from "../src/role-grants-store";
import type { DriveShareClient } from "../src/drive-client";
import { common } from "@dub/types";

/** Fake PermissionGranter driven by a rule(userId, key) => holds. */
export function memAuthz(rule: (userId: string, perm: identity.PermissionKey) => boolean): PermissionGranter {
  return async (userId, _orgId, keys) => keys.filter((k) => rule(userId, k));
}

/** Granter for a caller holding EXACTLY `keys` (anything else is denied). */
export function memAuthzHolding(...keys: identity.PermissionKey[]): PermissionGranter {
  const held = new Set<string>(keys);
  return memAuthz((_u, perm) => held.has(perm));
}

export const allowAll = memAuthz(() => true);

/** Drive共有 at 閲覧 — may read, must not write. */
export const DRIVE_READER = memAuthzHolding("app:driveshare:view", "drive:read");
/** Drive共有 at 編集 — full surface. */
export const DRIVE_EDITOR = memAuthzHolding("app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write");

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
