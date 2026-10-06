// Hono app factory. Split from the Worker entrypoint so tests build an app over a
// MemIdentityRepo + fake sinks with no Cloudflare runtime. Route layout follows the
// theme-10 prefix rule: external paths are /identity/* (gateway strips /api/v1);
// internal-only paths (/authz/check, /users/provision, /internal/*) are the INTERNAL rule
// in POLICY_TABLE (the second half of the double-defence, gateway 404 being the first).
//
// AUTHZ: no middleware and no permission check in this file beyond the ONE handler-layer
// assertion called out below.
// `policyGate` is the first decision point and the only key check — it derives authn (the
// trusted x-dub-user-id header) and authz from POLICY_TABLE (src/policy-table.ts), which
// lists every route here. Do NOT add a permission check, a requireAuth or an x-dub-internal
// check to a route or a handler — add the route to the table (test/policy-table.test.ts
// fails if you forget). Two things do NOT move into the table, because no static rule can
// express them (gate.ts's two-layer rule — they need request/row data):
//   - the SELF EXCEPTION on GET /identity/users/:id (whose record is it?) — below, and
//   - the LAST_ADMIN invariant (the last identity:admin holder cannot be disabled, offboarded
//     or stripped) — already in service.ts, where the admin count is loaded.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DubError, dubErrorHandler, errors, CommonErrorCodes } from "@dub/errors";
import { DUB_HEADERS, newRequestId } from "@dub/http";
import { policyGate } from "@dub/policy-gate";
import type { identity } from "@dub/types";
import type { AppVariables } from "./env";
import type { Deps } from "./deps";
import type { RequestCtx } from "./deps";
import { IdentityService } from "./service";
import { createInProcessGranter } from "./in-process-granter";
import { POLICY_TABLE } from "./policy-table";
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

  // request context (x-dub-request-id; entrypoints normally set it, allow generate as a
  // fallback). Pure x-dub-* header plumbing — it makes NO authorization decision; `userId`
  // is read here so audit records have an actor even on INTERNAL routes the gate does not
  // authenticate. It stays ahead of the gate so a deny is logged under this request's id.
  app.use("*", async (c, next) => {
    const requestId = c.req.header(DUB_HEADERS.requestId) ?? newRequestId();
    c.set("requestId", requestId);
    c.set("userId", c.req.header(DUB_HEADERS.userId) ?? null);
    await next();
  });

  // ---- THE authorization layer. Mounted on every route, so it runs before every handler,
  // including routes added below it; a route absent from POLICY_TABLE is denied (403), never
  // served. It replaces the whole set of hand-rolled middlewares this service used to carry
  // (requireAuth / requireInternal / requirePermission / requirePolicy / requireAdminEdit).
  //
  // `granted` is the one thing special about this service: an IN-PROCESS granter, because
  // identity-roster is the Worker that SERVES the /authz/check the normal granter calls (see
  // in-process-granter.ts — the wire granter would recurse into this same app). `orgId` is
  // the app's configured org so the granter asks about the org the handlers write to.
  //
  // `as MiddlewareHandler` is a typing bridge only (same as services/audit-log/src/app.ts):
  // policyGate is declared for an app whose Variables are exactly PolicyGateVars
  // (`userId: string`), while this app's AppVariables carries `userId: string | null` plus
  // requestId, and Hono's Context<E> is not comparable across that difference.
  app.use(
    "*",
    policyGate({
      service: "identity-roster",
      table: POLICY_TABLE,
      orgId,
      granted: createInProcessGranter(svc),
    }) as MiddlewareHandler,
  );

  app.get("/health", (c) => c.json({ ok: true, service: "identity-roster" }));

  // ===================== external (/identity/*) =====================
  const ext = new Hono<Env>();

  ext.get("/orgs", async (c) => {
    const limit = numParam(c.req.query("limit"));
    return c.json(await svc.listOrgs(limit, c.req.query("cursor")));
  });

  ext.get("/users", async (c) => {
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

  // THE ONE HANDLER-LAYER KEY CHECK IN THIS SERVICE, and it is load-bearing: the table
  // rule for this route is AUTHENTICATED (any session, no key), because a user may always
  // read their OWN detail without identity:read — which is request data the gate cannot see
  // (see the long note in src/policy-table.ts). Everyone ELSE's detail needs identity:read,
  // and that is asserted here. Deleting this branch opens every user's detail to every
  // signed-in caller; test/policy-table.test.ts's "self exception" block pins both halves.
  ext.get("/users/:id", async (c) => {
    const id = c.req.param("id");
    const requester = c.get("userId")!; // gate (AUTHENTICATED) 401s without a session
    if (id !== requester && !(await svc.can(requester, orgId, { permission: "identity:read" }))) {
      throw errors.forbidden("permission denied: identity:read");
    }
    return c.json(await svc.getUserDetail(id, orgId));
  });

  ext.post("/users/invite", async (c) => {
    const body = await readJson<{ email: string; displayName?: string; furigana?: string; roleIds?: string[] }>(c);
    return c.json(await svc.invite(orgId, body, ctxOf(c)), 201);
  });

  // Reconcile the roster with the Cloudflare Email Routing @developershub.jp addresses.
  // The caller (roster console, holds mail:admin) relays the addresses it read from the
  // mail-gateway proxy; identity upserts them by email (source=email-routing) synchronously.
  // #5: read-only diff preview — no writes; the console applies with the endpoint below.
  ext.post("/users/sync-email-routing/preview", async (c) => {
    const body = await readJson<{ addresses?: unknown }>(c);
    return c.json(await svc.previewEmailRouting(orgId, body as never));
  });
  ext.post("/users/sync-email-routing", async (c) => {
    const body = await readJson<{ addresses?: unknown }>(c);
    return c.json(await svc.syncEmailRouting(orgId, body as never, ctxOf(c)));
  });

  ext.patch("/users/:id", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await svc.updateUser(c.req.param("id"), orgId, body, ctxOf(c)));
  });

  // One-shot退任: revoke sessions + strip roles + disable, atomically & idempotently.
  // The cross-service steps (Email Routing削除・member在籍更新) are chained by the caller.
  ext.post("/users/:id/offboard", async (c) => {
    return c.json(await svc.offboardUser(c.req.param("id"), orgId, ctxOf(c)));
  });

  ext.get("/roles", async (c) => {
    return c.json(await svc.listRoles(orgId, numParam(c.req.query("limit")), c.req.query("cursor")));
  });
  ext.post("/roles", async (c) => {
    const body = await readJson<{ name: string; permissions: identity.PermissionKey[] }>(c);
    return c.json(await svc.createRole(orgId, body, ctxOf(c)), 201);
  });
  ext.patch("/roles/:id", async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    return c.json(await svc.updateRole(c.req.param("id"), orgId, body, ctxOf(c)));
  });
  ext.delete("/roles/:id", async (c) => {
    await svc.deleteRole(c.req.param("id"), orgId, ctxOf(c));
    return c.body(null, 204);
  });

  ext.get("/users/:id/roles", async (c) => {
    return c.json(await svc.listUserRoles(c.req.param("id"), orgId));
  });
  ext.post("/users/:id/roles", async (c) => {
    const body = await readJson<{ roleId: string; resourceType?: string; resourceId?: string }>(c);
    return c.json(await svc.assignRole(c.req.param("id"), orgId, body, ctxOf(c)), 201);
  });
  ext.delete("/users/:id/roles/:assignmentId", async (c) => {
    await svc.revokeRole(c.req.param("id"), c.req.param("assignmentId"), orgId, ctxOf(c));
    return c.body(null, 204);
  });

  ext.get("/permissions/catalog", (c) => c.json(catalog()));

  app.route("/identity", ext);

  // ===================== internal (INTERNAL in POLICY_TABLE) =====================
  // Every route below is `INTERNAL`: the gate requires the x-dub-internal marker that
  // @dub/http's createServiceClient sets on each s2s call and api-gateway strips off every
  // external request. Same enforcement the old `requireInternal` middleware gave, now
  // declared in the table where a reviewer can see it.
  app.post("/users/provision", async (c) => {
    const body = await readJson<{ email: string; displayName: string; githubLogin?: string }>(c);
    return c.json(await svc.provision(orgId, body, ctxOf(c)));
  });

  // Identity master by id — internal S2S read for the gateway /me composition.
  // External clients reach the user via /identity/users/:id (auth'd); the gateway
  // 404s this bare path, and the INTERNAL rule is the second line of defence.
  app.get("/users/:id", async (c) => {
    return c.json(await svc.getUser(c.req.param("id"), orgId));
  });

  // Self profile edit (アカウント設定 → 表示名/アバター) — internal S2S write. The gateway's
  // POST /api/v1/me/profile authenticates the session and forwards here scoped to the
  // caller's OWN userId (no admin gate, no client-supplied target). updateOwnProfile only
  // touches display_name / avatar_url, so it can never escalate roles or disable accounts.
  app.post("/internal/users/:id/profile", async (c) => {
    const body = await readJson<{ displayName?: string; avatarUrl?: string | null }>(c);
    return c.json(await svc.updateOwnProfile(c.req.param("id"), orgId, body, ctxOf(c)));
  });

  // Role → members expansion — internal S2S read for notification-service fan-out
  // (e.g. feedback → admin/maintainer inboxes). Mirrors the external GET /identity/users
  // role filter but is gated by x-dub-internal ONLY, not identity:read: the caller acts
  // on behalf of the system, so a feedback submitter without identity:read must still be
  // able to trigger admin notifications. `role` and `roleKey` are accepted spellings of
  // the same roleId filter. Returns the same { items, nextCursor } page shape.
  app.get("/internal/users", async (c) => {
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
  app.post("/internal/users/lookup", async (c) => {
    const body = await readJson<{ email?: string }>(c);
    if (!body || typeof body.email !== "string" || body.email.length === 0) {
      throw errors.validationFailed([{ field: "email", reason: "required" }]);
    }
    return c.json(await svc.lookupByEmail(orgId, body.email));
  });

  // The ecosystem's authorization decision point — what every other service's granter calls.
  // INTERNAL in the table, so it is unreachable from outside (no permission oracle), and the
  // gate protecting it must never be wired to a granter that calls THIS route: see
  // src/in-process-granter.ts.
  app.post("/authz/check", async (c) => {
    const body = await readJson<identity.AuthzCheckRequest>(c);
    if (!body || typeof body.subjectUserId !== "string" || typeof body.orgId !== "string") {
      throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "subjectUserId and orgId are required", { status: 400 });
    }
    return c.json(await svc.authzCheck(body));
  });

  app.get("/internal/users/:id/permissions", async (c) => {
    return c.json(await svc.effectivePermissions(c.req.param("id"), orgId));
  });

  return app;
}

function numParam(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
