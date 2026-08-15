// Hono app factory. Split from the Worker entrypoint so tests build an app over a
// MemIdentityRepo + fake sinks with no Cloudflare runtime. Route layout follows the
// theme-10 prefix rule: external paths are /identity/* (gateway strips /api/v1);
// internal-only paths (/authz/check, /users/provision, /internal/*) demand
// x-dub-internal (the second half of the double-defence, gateway 404 being the first).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DubError, dubErrorHandler, errors, CommonErrorCodes } from "@dub/errors";
import { DUB_HEADERS, newRequestId } from "@dub/http";
import type { identity } from "@dub/types";
import type { AppVariables } from "./env";
import type { Deps } from "./deps";
import type { RequestCtx } from "./deps";
import { IdentityService } from "./service";
import { catalog } from "./permissions";

export interface AppOptions {
  deps: Deps;
  defaultOrgId: string;
}

type Env = { Variables: AppVariables };
type Ctx = Context<Env>;
type App = Hono<Env>;

function ctxOf(c: Ctx): RequestCtx {
  return { requestId: c.get("requestId"), actorId: c.get("userId") };
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(opts: AppOptions): App {
  const svc = new IdentityService(opts.deps);
  const orgId = opts.defaultOrgId;
  const app = new Hono<Env>();

  app.onError(dubErrorHandler({ service: "identity-roster" }));

  // request context (x-dub-request-id; entrypoints normally set it, allow generate as a fallback)
  app.use("*", async (c, next) => {
    const requestId = c.req.header(DUB_HEADERS.requestId) ?? newRequestId();
    c.set("requestId", requestId);
    c.set("userId", c.req.header(DUB_HEADERS.userId) ?? null);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, service: "identity-roster" }));

  // ---- middleware factories ----
  const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
    if (!c.get("userId")) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
    await next();
  };
  const requireInternal: MiddlewareHandler<Env> = async (c, next) => {
    if (c.req.header(DUB_HEADERS.internal) !== "1") throw errors.forbidden("internal-only endpoint");
    await next();
  };
  const requirePermission = (permission: identity.PermissionKey): MiddlewareHandler<Env> => async (c, next) => {
    const userId = c.get("userId");
    if (!userId) throw new DubError("AUTH_INVALID_TOKEN", "unauthenticated", { status: 401 });
    if (!(await svc.can(userId, orgId, { permission }))) throw errors.forbidden(`permission denied: ${permission}`);
    await next();
  };

  // ===================== external (/identity/*) =====================
  const ext = new Hono<Env>();
  ext.use("*", requireAuth);

  ext.get("/orgs", requirePermission("identity:read"), async (c) => {
    const limit = numParam(c.req.query("limit"));
    return c.json(await svc.listOrgs(limit, c.req.query("cursor")));
  });

  ext.get("/users", requirePermission("identity:read"), async (c) => {
    const idsRaw = c.req.query("ids");
    const ids = idsRaw ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const status = c.req.query("status") as identity.UserStatus | undefined;
    // `role` is the task's filter param; `roleKey` is the FE7 client's spelling
    // (lib/listUsersQuery). Accept both, same semantics (a roleId to filter by).
    const roleId = c.req.query("role") ?? c.req.query("roleKey");
    const q = c.req.query("q");
    const out = await svc.listUsers(orgId, {
      ...(ids ? { ids } : {}),
      ...(status ? { status } : {}),
      ...(roleId ? { roleId } : {}),
      ...(q ? { q } : {}),
      ...(c.req.query("limit") ? { limit: numParam(c.req.query("limit")) } : {}),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
    });
    return c.json(out);
  });

  ext.get("/users/:id", async (c) => {
    const id = c.req.param("id");
    const requester = c.get("userId")!;
    // self-read is always permitted; otherwise identity:read is required.
    if (id !== requester && !(await svc.can(requester, orgId, { permission: "identity:read" }))) {
      throw errors.forbidden("permission denied: identity:read");
    }
    return c.json(await svc.getUserDetail(id, orgId));
  });

  ext.post("/users/invite", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<{ email: string; displayName?: string; roleIds?: string[] }>(c);
    return c.json(await svc.invite(orgId, body, ctxOf(c)), 201);
  });

  // Reconcile the roster with the Cloudflare Email Routing @developershub.jp addresses.
  // The caller (roster console, holds mail:admin) relays the addresses it read from the
  // mail-gateway proxy; identity upserts them by email (source=email-routing) synchronously.
  // #5: read-only diff preview — no writes; the console applies with the endpoint below.
  ext.post("/users/sync-email-routing/preview", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<{ addresses?: unknown }>(c);
    return c.json(await svc.previewEmailRouting(orgId, body as never));
  });
  ext.post("/users/sync-email-routing", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<{ addresses?: unknown }>(c);
    return c.json(await svc.syncEmailRouting(orgId, body as never, ctxOf(c)));
  });

  ext.patch("/users/:id", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await svc.updateUser(c.req.param("id"), orgId, body, ctxOf(c)));
  });

  // One-shot退任: revoke sessions + strip roles + disable, atomically & idempotently.
  // The cross-service steps (Email Routing削除・member在籍更新) are chained by the caller.
  ext.post("/users/:id/offboard", requirePermission("identity:admin"), async (c) => {
    return c.json(await svc.offboardUser(c.req.param("id"), orgId, ctxOf(c)));
  });

  ext.get("/roles", requirePermission("identity:read"), async (c) => {
    return c.json(await svc.listRoles(orgId, numParam(c.req.query("limit")), c.req.query("cursor")));
  });
  ext.post("/roles", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<{ name: string; permissions: identity.PermissionKey[] }>(c);
    return c.json(await svc.createRole(orgId, body, ctxOf(c)), 201);
  });
  ext.patch("/roles/:id", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await svc.updateRole(c.req.param("id"), orgId, body, ctxOf(c)));
  });
  ext.delete("/roles/:id", requirePermission("identity:admin"), async (c) => {
    await svc.deleteRole(c.req.param("id"), orgId, ctxOf(c));
    return c.body(null, 204);
  });

  ext.get("/users/:id/roles", requirePermission("identity:read"), async (c) => {
    return c.json(await svc.listUserRoles(c.req.param("id"), orgId));
  });
  ext.post("/users/:id/roles", requirePermission("identity:admin"), async (c) => {
    const body = await readJson<{ roleId: string; resourceType?: string; resourceId?: string }>(c);
    return c.json(await svc.assignRole(c.req.param("id"), orgId, body, ctxOf(c)), 201);
  });
  ext.delete("/users/:id/roles/:assignmentId", requirePermission("identity:admin"), async (c) => {
    await svc.revokeRole(c.req.param("id"), c.req.param("assignmentId"), orgId, ctxOf(c));
    return c.body(null, 204);
  });

  ext.get("/permissions/catalog", requirePermission("identity:read"), (c) => c.json(catalog()));

  app.route("/identity", ext);

  // ===================== internal (x-dub-internal) =====================
  app.post("/users/provision", requireInternal, async (c) => {
    const body = await readJson<{ email: string; displayName: string; githubLogin?: string }>(c);
    return c.json(await svc.provision(orgId, body, ctxOf(c)));
  });

  // Identity master by id — internal S2S read for the gateway /me composition.
  // External clients reach the user via /identity/users/:id (auth'd); the gateway
  // 404s this bare path, and requireInternal is the second line of defence.
  app.get("/users/:id", requireInternal, async (c) => {
    return c.json(await svc.getUser(c.req.param("id"), orgId));
  });

  // Role → members expansion — internal S2S read for notification-service fan-out
  // (e.g. feedback → admin/maintainer inboxes). Mirrors the external GET /identity/users
  // role filter but is gated by x-dub-internal ONLY, not identity:read: the caller acts
  // on behalf of the system, so a feedback submitter without identity:read must still be
  // able to trigger admin notifications. `role` and `roleKey` are accepted spellings of
  // the same roleId filter. Returns the same { items, nextCursor } page shape.
  app.get("/internal/users", requireInternal, async (c) => {
    const roleId = c.req.query("role") ?? c.req.query("roleKey");
    const status = c.req.query("status") as identity.UserStatus | undefined;
    const out = await svc.listUsers(orgId, {
      ...(roleId ? { roleId } : {}),
      ...(status ? { status } : {}),
      ...(c.req.query("limit") ? { limit: numParam(c.req.query("limit")) } : {}),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
    });
    return c.json(out);
  });

  // Login allowlist lookup — internal S2S read for auth-service password login.
  // Returns { user } (any status) or { user: null } when the email is not on the
  // roster; auth-service enforces the active-only allowlist. Read-only (no provision
  // side effects), so probing this never mutates roster state.
  app.post("/internal/users/lookup", requireInternal, async (c) => {
    const body = await readJson<{ email?: string }>(c);
    if (!body || typeof body.email !== "string" || body.email.length === 0) {
      throw errors.validationFailed([{ field: "email", reason: "required" }]);
    }
    return c.json(await svc.lookupByEmail(orgId, body.email));
  });

  app.post("/authz/check", requireInternal, async (c) => {
    const body = await readJson<identity.AuthzCheckRequest>(c);
    if (!body || typeof body.subjectUserId !== "string" || typeof body.orgId !== "string") {
      throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "subjectUserId and orgId are required", { status: 400 });
    }
    return c.json(await svc.authzCheck(body));
  });

  app.get("/internal/users/:id/permissions", requireInternal, async (c) => {
    return c.json(await svc.effectivePermissions(c.req.param("id"), orgId));
  });

  return app;
}

function numParam(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
