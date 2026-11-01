// Shared in-memory fakes for drive-share-service unit tests. No network, no real bindings.
import type { PermissionGranter } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import type { ActiveUser, RoleMembership } from "../src/role-membership";
import { createRoleGrantsService, type RoleGrantsService } from "../src/role-grants-service";
import { createInMemoryRoleGrantStore, type RoleGrantStore } from "../src/role-grants-store";
import type { DriveShareClient } from "../src/drive-client";
import { common } from "@dub/types";
import { createGoogleAccountService, type GoogleAccountService } from "../src/google-account";
import { createInMemoryGoogleAccountStore } from "../src/google-account-store";
import type { Env } from "../src/env";
import { createMeetingsService } from "../src/meetings-service";
import { createInMemoryMeetingStore } from "../src/meetings-store";
import { createMockCalendarClient } from "../src/calendar-mock-client";
import { staticMemberDirectory, type MemberDirectory } from "../src/member-directory";
import type { CalendarClient } from "../src/google/calendar-client";

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
  users: ActiveUser[] = [],
): RoleMembership {
  return {
    async listActiveUsers(roleId?: string): Promise<ActiveUser[]> {
      return users.filter((u) => !roleId || u.roleIds.includes(roleId)).map((u) => ({ ...u, roleIds: [...u.roleIds] }));
    },
    async listRoles() {
      return Object.entries(names).map(([id, name]) => ({ id, name }));
    },
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

/** Google-account service over an in-memory store with no secrets (status = none). */
export function stubGoogleAccount(): GoogleAccountService {
  return createGoogleAccountService({
    env: {} as Env,
    store: createInMemoryGoogleAccountStore(),
    orgId: common.DUB_DEFAULT_ORG_ID,
    key: null,
    fetchImpl: (async () => {
      throw new Error("no network in unit tests");
    }) as unknown as typeof fetch,
  });
}

/** カレンダー > ミーティング over an in-memory store + the mock calendar (ready account). */
export function buildMeetings(opts: {
  roster?: RoleMembership;
  directory?: MemberDirectory;
  calendar?: CalendarClient;
  calendarReady?: boolean;
  accountId?: string;
  accountEmail?: string | null;
  store?: ReturnType<typeof createInMemoryMeetingStore>;
  googleBudget?: number;
  syncTimeLimitMs?: number;
  now?: () => string;
  meetReady?: boolean;
} = {}) {
  const store = opts.store ?? createInMemoryMeetingStore();
  const calendar = opts.calendar ?? createMockCalendarClient();
  let seq = 0;
  let tick = 0;
  const kicks: (number | undefined)[] = [];
  const service = createMeetingsService({
    store,
    roster: opts.roster ?? fakeRoster({}, {}),
    directory: opts.directory ?? staticMemberDirectory(),
    account: async () => ({
      accountId: opts.accountId ?? "dga_1",
      email: opts.accountEmail === undefined ? "hackit@gmail.com" : opts.accountEmail,
      calendarReady: opts.calendarReady ?? true,
      meetReady: opts.meetReady ?? true,
      calendar,
    }),
    orgId: common.DUB_DEFAULT_ORG_ID,
    now: opts.now ?? (() => `2026-10-14T00:00:${String(tick++ % 60).padStart(2, "0")}.000Z`),
    newId: () => `dsm_test_${++seq}`,
    kick: async (soonMs?: number) => {
      kicks.push(soonMs);
    },
    ...(opts.googleBudget ? { googleBudget: opts.googleBudget } : {}),
    ...(opts.syncTimeLimitMs ? { syncTimeLimitMs: opts.syncTimeLimitMs } : {}),
  });
  return { service, store, calendar, kicks };
}
