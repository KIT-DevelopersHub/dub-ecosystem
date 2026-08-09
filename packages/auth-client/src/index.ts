// @dub/auth-client — one uniform way to obtain authn context (trusted header) and
// perform authz checks (identity /authz/check) across all services. No business logic.
import type { MiddlewareHandler, Context } from "hono";
import type { Fetcher } from "@cloudflare/workers-types";
import { DubError, CommonErrorCodes } from "@dub/errors";
import { createServiceClient, newRequestId, DUB_HEADERS, type RequestContext, type ServiceClient } from "@dub/http";
import { auth, identity, common } from "@dub/types";

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(
  identity.PERMISSION_CATALOG.filter((e) => e.dangerous).map((e) => e.key),
);

export type AuthMode = "trustedHeader" | "verify";

export interface AuthzCacheConfig {
  enabled?: boolean; // default true
  maxEntries?: number; // default 1000 (isolate LRU)
}
export interface AuthClientConfig {
  identityBinding: Fetcher; // identity-roster Service Binding (all services)
  authBinding?: Fetcher; // auth-service SB (mode:"verify" entrypoints only)
  serviceName: string; // caller name (correlation/log)
  mode?: AuthMode; // default "trustedHeader"
  authzCache?: AuthzCacheConfig;
}
export interface AuthzCallOptions {
  fresh?: boolean; // bypass cache (read+write) for strong operations
  requestId?: string; // propagated to identity call; middleware supplies dubCtx.requestId
}

export interface AuthnContext {
  userId: common.UserId;
  source: "trusted_header" | "verify";
  session: auth.SessionInfo | null; // non-null only in mode:"verify"
}

export interface AuthClient {
  verify(ctx: RequestContext, token: string): Promise<auth.AuthVerifyResponse>;
  requireAuth(): MiddlewareHandler;
  checkPermissions(req: identity.AuthzCheckRequest, opts?: AuthzCallOptions): Promise<identity.AuthzCheckResponse>;
  hasPermission(subjectUserId: common.UserId, orgId: common.OrgId, check: identity.AuthzQuery, opts?: AuthzCallOptions): Promise<boolean>;
  requirePermission(
    permission: identity.PermissionKey,
    resolve?: (c: Context) => { orgId?: common.OrgId; resourceType?: string; resourceId?: string },
    opts?: AuthzCallOptions,
  ): MiddlewareHandler;
  invalidateAuthzCache(userId?: common.UserId): void;
}

interface CacheEntry {
  decision: identity.AuthzDecision;
  expiresAt: number;
  userId: common.UserId;
}

function cacheKey(userId: string, orgId: string, q: identity.AuthzQuery): string {
  return `${userId}|${orgId}|${q.permission}|${q.resourceType ?? ""}|${q.resourceId ?? ""}`;
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const mode: AuthMode = config.mode ?? "trustedHeader";
  const cacheEnabled = config.authzCache?.enabled ?? true;
  const maxEntries = config.authzCache?.maxEntries ?? 1000;
  const cache = new Map<string, CacheEntry>();

  const identityClient: ServiceClient = createServiceClient(config.identityBinding, {
    service: "identity-roster",
    caller: config.serviceName,
  });

  function putCache(key: string, entry: CacheEntry): void {
    if (!cacheEnabled) return;
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
  }

  async function checkPermissions(req: identity.AuthzCheckRequest, opts?: AuthzCallOptions): Promise<identity.AuthzCheckResponse> {
    if (req.checks.length === 0 || req.checks.length > 20) {
      throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "checks must be 1..20", {
        status: 400,
        details: [{ field: "checks", reason: req.checks.length === 0 ? "required" : "too_long" }],
      });
    }
    const now = Date.now();
    const decisions: (identity.AuthzDecision | undefined)[] = new Array(req.checks.length);
    const missIdx: number[] = [];

    req.checks.forEach((q, i) => {
      const dangerous = DANGEROUS_KEYS.has(q.permission);
      if (opts?.fresh || dangerous || !cacheEnabled) {
        missIdx.push(i);
        return;
      }
      const hit = cache.get(cacheKey(req.subjectUserId, req.orgId, q));
      if (hit && hit.expiresAt > now) decisions[i] = hit.decision;
      else missIdx.push(i);
    });

    if (missIdx.length > 0) {
      const subReq: identity.AuthzCheckRequest = {
        subjectUserId: req.subjectUserId,
        orgId: req.orgId,
        checks: missIdx.map((i) => req.checks[i]!),
      };
      const ctx: RequestContext = { requestId: opts?.requestId ?? newRequestId() };
      // fail-closed: any transport failure propagates (never resolves to allow).
      const res = await identityClient.post<identity.AuthzCheckResponse>(ctx, "/authz/check", subReq);
      res.decisions.forEach((d, j) => {
        const i = missIdx[j]!;
        decisions[i] = d;
        const q = req.checks[i]!;
        const dangerous = DANGEROUS_KEYS.has(q.permission);
        if (!opts?.fresh && !dangerous) {
          putCache(cacheKey(req.subjectUserId, req.orgId, q), {
            decision: d,
            expiresAt: now + d.ttlSeconds * 1000,
            userId: req.subjectUserId,
          });
        }
      });
    }

    return { decisions: decisions.map((d) => d ?? { allowed: false, evaluatedAt: new Date(now).toISOString(), ttlSeconds: 0 }) };
  }

  async function hasPermission(subjectUserId: common.UserId, orgId: common.OrgId, check: identity.AuthzQuery, opts?: AuthzCallOptions): Promise<boolean> {
    const res = await checkPermissions({ subjectUserId, orgId, checks: [check] }, opts);
    return res.decisions[0]?.allowed ?? false;
  }

  function invalidateAuthzCache(userId?: common.UserId): void {
    if (userId === undefined) {
      cache.clear();
      return;
    }
    for (const [key, entry] of cache) if (entry.userId === userId) cache.delete(key);
  }

  async function verify(ctx: RequestContext, token: string): Promise<auth.AuthVerifyResponse> {
    if (!config.authBinding) throw new DubError("AUTH_INVALID_TOKEN", "verify mode requires authBinding", { status: 401 });
    const authClient = createServiceClient(config.authBinding, { service: "auth-service", caller: config.serviceName });
    const body: auth.AuthVerifyRequest = { token };
    return authClient.post<auth.AuthVerifyResponse>(ctx, "/verify", body);
  }

  function extractToken(c: Context): string | null {
    const authz = c.req.header("authorization");
    if (authz && authz.toLowerCase().startsWith("bearer ")) return authz.slice(7).trim();
    const cookie = c.req.header("cookie");
    if (cookie) {
      const m = /(?:^|;\s*)dub_session=([^;]+)/.exec(cookie);
      if (m && m[1]) return decodeURIComponent(m[1]);
    }
    return null;
  }

  function requireAuth(): MiddlewareHandler {
    return async (c, next) => {
      if (mode === "trustedHeader") {
        const userId = c.req.header(DUB_HEADERS.userId);
        if (!userId) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
        const authn: AuthnContext = { userId, source: "trusted_header", session: null };
        c.set("authn", authn);
      } else {
        const token = extractToken(c);
        if (!token) throw new DubError("AUTH_INVALID_TOKEN", "no bearer/cookie token", { status: 401 });
        const requestId = c.req.header(DUB_HEADERS.requestId) ?? newRequestId();
        const res = await verify({ requestId }, token);
        if (!res.valid || !res.userId) {
          const reason = res.reason;
          const code = reason === "expired" ? "AUTH_SESSION_EXPIRED" : reason === "revoked" ? "AUTH_SESSION_REVOKED" : "AUTH_INVALID_TOKEN";
          throw new DubError(code, `verify failed: ${reason ?? "invalid"}`, { status: 401 });
        }
        const authn: AuthnContext = { userId: res.userId, source: "verify", session: res.session };
        c.set("authn", authn);
      }
      await next();
    };
  }

  function requirePermission(
    permission: identity.PermissionKey,
    resolve?: (c: Context) => { orgId?: common.OrgId; resourceType?: string; resourceId?: string },
    opts?: AuthzCallOptions,
  ): MiddlewareHandler {
    return async (c, next) => {
      const authn = c.get("authn") as AuthnContext | undefined;
      if (!authn) throw new DubError("AUTH_INVALID_TOKEN", "requireAuth must run before requirePermission", { status: 401 });
      const scope = resolve?.(c) ?? {};
      const orgId = scope.orgId ?? common.DUB_DEFAULT_ORG_ID;
      const query: identity.AuthzQuery = { permission, ...(scope.resourceType ? { resourceType: scope.resourceType } : {}), ...(scope.resourceId ? { resourceId: scope.resourceId } : {}) };
      const requestId = c.req.header(DUB_HEADERS.requestId) ?? undefined;
      const allowed = await hasPermission(authn.userId, orgId, query, { ...opts, ...(requestId ? { requestId } : {}) });
      if (!allowed) throw new DubError(CommonErrorCodes.FORBIDDEN, `permission denied: ${permission}`, { status: 403 });
      await next();
    };
  }

  return { verify, requireAuth, checkPermissions, hasPermission, requirePermission, invalidateAuthzCache };
}

// ---- context helpers ----
export function getAuthn(c: Context): AuthnContext {
  const authn = c.get("authn") as AuthnContext | undefined;
  if (!authn) throw new DubError("AUTH_INVALID_TOKEN", "authn context missing", { status: 401 });
  return authn;
}
export function getUserId(c: Context): common.UserId {
  return getAuthn(c).userId;
}
export function getSessionOrNull(c: Context): auth.SessionInfo | null {
  return getAuthn(c).session;
}

export type AuthClientErrorCode =
  | "AUTH_INVALID_TOKEN"
  | "AUTH_SESSION_EXPIRED"
  | "AUTH_SESSION_REVOKED"
  | "FORBIDDEN"
  | "VALIDATION_FAILED";
