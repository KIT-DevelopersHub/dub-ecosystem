// Role → members expansion via the identity-roster Service Binding. This is the ONLY
// place drive-share-service reaches identity for role data. Mirrors the /authz/check
// wiring in index.ts (createServiceClient) but hits:
//   • GET /internal/users?role=<roleId>&status=active — the internal S2S role expansion
//     (x-dub-internal only, no identity:read needed). Paginated via nextCursor.
//   • GET /identity/roles — role id→name map for display (identity:read; every system
//     role carries identity:read, so the forwarded acting user always passes).
// A fresh instance is built per request (memoisation is request-scoped, so a long-lived
// isolate never serves stale role membership).
import { createServiceClient, type RequestContext } from "@dub/http";
import type { Fetcher } from "@cloudflare/workers-types";

/** An active Dub account as カレンダー > ミーティング needs it. */
export interface ActiveUser {
  id: string;
  /** Dub login address (trimmed, lowercased). */
  email: string;
  name: string;
  roleIds: string[];
}

/** Role membership + naming, as drive-share-service needs it. */
export interface RoleMembership {
  /** Active member emails of a role (trimmed, lowercased, de-duplicated). */
  listActiveEmails(roleId: string): Promise<string[]>;
  /** Human-readable role name, or null if the role id is unknown. */
  roleName(roleId: string): Promise<string | null>;
  /** Active users of a role, or of the whole org when roleId is omitted ("全体"). Internal S2S
   *  only, so it also works for the system actor of the hourly meeting sync. */
  listActiveUsers(roleId?: string): Promise<ActiveUser[]>;
  /** Every role (id + name). Needs the acting user (identity:read). */
  listRoles(): Promise<{ id: string; name: string }[]>;
}

/** Builds a request-scoped RoleMembership for the acting user. */
export type RoleMembershipFactory = (ctx: RequestContext) => RoleMembership;

const PAGE_LIMIT = 200;

interface UsersPage {
  items: { id?: string; email?: string | null; displayName?: string | null; roleIds?: string[] | null }[];
  nextCursor: string | null;
}
interface RolesPage {
  items: { id: string; name: string }[];
  nextCursor: string | null;
}

export function createIdentityRoleMembership(binding: Fetcher, ctx: RequestContext): RoleMembership {
  const client = createServiceClient(binding, { service: "identity-roster", caller: "drive-share-service" });
  let rolesCache: Map<string, string> | null = null;

  async function loadRoles(): Promise<Map<string, string>> {
    if (rolesCache) return rolesCache;
    const map = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = await client.get<RolesPage>(ctx, "/identity/roles", {
        query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      for (const r of page.items) map.set(r.id, r.name);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    rolesCache = map;
    return map;
  }

  return {
    async listActiveEmails(roleId: string): Promise<string[]> {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.get<UsersPage>(ctx, "/internal/users", {
          query: { role: roleId, status: "active", limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        for (const u of page.items) {
          const email = u.email?.trim().toLowerCase();
          if (email) seen.add(email);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return [...seen];
    },

    async roleName(roleId: string): Promise<string | null> {
      const roles = await loadRoles();
      return roles.get(roleId) ?? null;
    },

    async listActiveUsers(roleId?: string): Promise<ActiveUser[]> {
      const out = new Map<string, ActiveUser>();
      let cursor: string | undefined;
      do {
        const page = await client.get<UsersPage>(ctx, "/internal/users", {
          query: { ...(roleId ? { role: roleId } : {}), status: "active", limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        for (const u of page.items) {
          const email = u.email?.trim().toLowerCase();
          if (!u.id || !email || out.has(u.id)) continue;
          out.set(u.id, { id: u.id, email, name: u.displayName?.trim() || email, roleIds: [...(u.roleIds ?? [])] });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return [...out.values()];
    },

    async listRoles(): Promise<{ id: string; name: string }[]> {
      return [...(await loadRoles())].map(([id, name]) => ({ id, name }));
    },
  };
}
