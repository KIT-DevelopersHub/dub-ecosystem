// Test harness: builds AppDeps around the in-memory repo with an injectable fake
// authz. Drives the real Hono app end-to-end without D1 / Service Bindings.
import type { MiddlewareHandler, Context } from "hono";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { common, identity } from "@dub/types";
import { policy } from "@dub/types";
import { createApp } from "../src/app";
import { InMemoryMemberRepo } from "../src/memory-repo";
import type { AppDeps, Authz } from "../src/types";

// Authz that grants a fixed permission set. requireAuth enforces x-dub-user-id.
export function fakeAuthz(granted: Set<identity.PermissionKey>): Authz {
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        const userId = c.req.header("x-dub-user-id");
        if (!userId) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
        await next();
      };
    },
    requirePermission(
      permission: identity.PermissionKey,
      _resolve?: (c: Context) => { orgId?: string; resourceType?: string; resourceId?: string },
    ): MiddlewareHandler {
      return async (_c, next) => {
        if (!granted.has(permission)) {
          throw new DubError(CommonErrorCodes.FORBIDDEN, `permission denied: ${permission}`, { status: 403 });
        }
        await next();
      };
    },
    // Mirrors @dub/auth-client's requireAppAccess: decide with the REAL policy module over
    // the granted set, so a test's permission set exercises the same semantics as production
    // (no second, hand-rolled notion of 無効/閲覧/編集 in the fake).
    requireAppAccess(
      app: string,
      level: policy.AppAccessLevel,
      extra?: { permission?: identity.PermissionKey },
    ): MiddlewareHandler {
      return async (_c, next) => {
        const decision = policy.decide(granted, { app, level, ...(extra?.permission ? { permission: extra.permission } : {}) });
        if (!decision.allowed) {
          throw new DubError(CommonErrorCodes.FORBIDDEN, policy.denyMessage(decision), { status: 403 });
        }
        await next();
      };
    },
    async hasPermission(_userId, _orgId, query: identity.AuthzQuery): Promise<boolean> {
      return granted.has(query.permission);
    },
  };
}

/** The keys an "admin-like" test subject holds: the identity domain keys plus 編集 on every
 *  app this service hosts. Derived from the policy layer so a new app/level is picked up
 *  automatically instead of drifting from production grants. */
export function adminGrants(): Set<identity.PermissionKey> {
  return new Set<identity.PermissionKey>([
    "identity:read",
    "identity:admin",
    ...policy.keysForAppLevel("members", "edit"),
    ...policy.keysForAppLevel("participation", "edit"),
  ]);
}

let seq = 0;
export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & { repo: InMemoryMemberRepo } {
  const repo = new InMemoryMemberRepo();
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(adminGrants()),
    orgId: "org_devhub" as common.OrgId,
    now: () => "2026-08-12T00:00:00.000Z",
    newTeamId: () => `team_${String(seq++).padStart(6, "0")}`,
    newMemberId: () => `member_${String(seq++).padStart(6, "0")}`,
    newParticipationId: () => `part_${String(seq++).padStart(6, "0")}`,
    ...overrides,
  };
  return Object.assign(deps, { repo });
}

export interface CallInit {
  userId?: string | null; // null = omit header (unauthenticated)
  body?: unknown;
  internal?: boolean; // set x-dub-internal (genuine s2s call, e.g. /members/internal/*)
}

export async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  init: CallInit = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "x-dub-request-id": "req_test" };
  if (init.userId !== null) headers["x-dub-user-id"] = init.userId ?? "user_caller";
  if (init.internal) headers["x-dub-internal"] = "1";
  const reqInit: RequestInit = { method, headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.body);
  }
  const res = await app.request(`http://svc${path}`, reqInit);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export { createApp };
