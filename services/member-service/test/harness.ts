// Test harness: builds AppDeps around the in-memory repo with an injectable fake
// authz. Drives the real Hono app end-to-end without D1 / Service Bindings.
import type { MiddlewareHandler, Context } from "hono";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { common, identity } from "@dub/types";
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
    async hasPermission(_userId, _orgId, query: identity.AuthzQuery): Promise<boolean> {
      return granted.has(query.permission);
    },
  };
}

let seq = 0;
export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & { repo: InMemoryMemberRepo } {
  const repo = new InMemoryMemberRepo();
  const deps: AppDeps = {
    repo,
    authz: fakeAuthz(new Set<identity.PermissionKey>(["identity:read", "identity:admin"])),
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
