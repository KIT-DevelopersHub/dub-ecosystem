// MO3 mobile-bff HTTP surface (Hono). Single mobile entry (MO1/MO2 know only MO3):
// (1) entry cross-cutting — fresh requestId per request, verify Bearer once, never
//     trust inbound x-dub-* (the @dub/http client re-adds trusted headers downstream);
// (2) BFF aggregation (/m/v1/bff/*); (3) thin transparent proxy (logic-free forward);
// (4) push dispatch (/internal/push/dispatch, Service-Binding only). sync/mutations
// are contract-frozen STUB → 501 (theme14 D2). Built from injected Deps → fully
// testable without the Cloudflare runtime.
import { Hono, type MiddlewareHandler } from "hono";
import { dubErrorHandler, errors, type FieldError } from "@dub/errors";
import { type RequestContext, type ServiceClient } from "@dub/http";
import { HDR_INTERNAL, INTERNAL_HEADER_VALUE } from "@dub/observability";
import { newId } from "@dub/db";
import type { auth, mobile } from "@dub/types";
import type { Deps } from "./deps";
import { mobileErrors } from "./errors";
import { toDeviceDto } from "./devices";
import { buildHome, buildEventOverview } from "./bff";
import { dispatchPush } from "./push";

type Variables = { requestId: string; userId?: string };

// ---- local response shapes (requests/DTOs are frozen in @dub/types mobile ns) ----
interface TokenSessionResponse {
  token: string;
  session: auth.SessionInfo;
}
type RefreshResponse = { token: string; session: auth.SessionInfo } | { session: auth.SessionInfo };
interface ListDevicesResponse {
  devices: mobile.DeviceDto[];
}
interface PushDispatchBody extends mobile.PushDispatchRequest {
  notificationId?: string; // frozen PushDispatchRequest lacks it; accepted off-wire
}

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

async function readJsonOrUndefined(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined; // empty body (e.g. read-all) is valid for the proxy
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    const fe: FieldError = { field, reason: "required" };
    throw errors.validationFailed([fe]);
  }
  return value;
}

function requirePlatform(value: unknown): mobile.MobilePlatform {
  if (value !== "ios" && value !== "android") {
    throw errors.validationFailed([{ field: "platform", reason: "invalid" }]);
  }
  return value;
}

function requireInternal(c: { req: { header: (n: string) => string | undefined } }): void {
  if (c.req.header(HDR_INTERNAL) !== INTERNAL_HEADER_VALUE) throw mobileErrors.internalOnly();
}

export function buildApp(deps: Deps): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.onError(dubErrorHandler({ service: "mobile-bff" }));

  // Entry: mint a fresh correlation id every request (external x-dub-* is ignored).
  app.use("*", async (c, next) => {
    c.set("requestId", deps.newRequestId());
    await next();
  });

  const publicCtx = (c: { get: (k: "requestId") => string }): RequestContext => ({ requestId: c.get("requestId") });
  const authedCtx = (c: { get: (k: "requestId" | "userId") => string }): RequestContext => ({
    requestId: c.get("requestId"),
    userId: c.get("userId"),
  });

  const requireAuth: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const token = bearer(c);
    if (!token) throw errors.unauthenticated("missing bearer token");
    const res = await deps.authenticator.verify(publicCtx(c), token);
    if (!res.valid || !res.userId) throw errors.unauthenticated(`token ${res.reason ?? "invalid"}`);
    c.set("userId", res.userId);
    await next();
  };

  // Logic-free transparent forward: preserves委譲先 body/query/error form (409 透過).
  async function proxy(
    c: Parameters<MiddlewareHandler<{ Variables: Variables }>>[0],
    client: ServiceClient,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
  ): Promise<Response> {
    const ctx = authedCtx(c);
    const query = c.req.query();
    let res: unknown;
    if (method === "GET") res = await client.get(ctx, path, { query });
    else if (method === "DELETE") res = await client.delete(ctx, path, { query });
    else {
      const body = await readJsonOrUndefined(c);
      res = method === "POST" ? await client.post(ctx, path, body, { query }) : await client.patch(ctx, path, body, { query });
    }
    if (res === undefined) return c.body(null, 204);
    return c.json(res as Record<string, unknown>);
  }

  // ================= health =================
  app.get("/healthz", (c) => c.json({ ok: true, service: "mobile-bff" }));

  // ================= mobile OAuth entry (theme8: token透過・自前発行しない) =================
  // POST /m/v1/auth/exchange (public) -> auth /mobile/exchange (x-dub-internal added by client)
  app.post("/m/v1/auth/exchange", async (c) => {
    const body = await readJson<{ code?: string; authorizationCode?: string }>(c);
    const code = requireString(body.code ?? body.authorizationCode, "code");
    const req: auth.MobileExchangeRequest = { code };
    const res = await deps.auth.post<TokenSessionResponse, auth.MobileExchangeRequest>(publicCtx(c), "/mobile/exchange", req);
    return c.json(res);
  });

  // POST /m/v1/auth/refresh (public) -> auth /auth/refresh (bearer path)
  app.post("/m/v1/auth/refresh", async (c) => {
    const inbound = bearer(c);
    const body = (await readJsonOrUndefined(c)) as { refreshToken?: string } | undefined;
    const token = inbound ?? body?.refreshToken;
    const req: auth.AuthRefreshRequest = token ? { refreshToken: token } : {};
    const res = await deps.auth.post<RefreshResponse, auth.AuthRefreshRequest>(publicCtx(c), "/auth/refresh", req);
    return c.json(res);
  });

  // POST /m/v1/auth/logout (本人) -> auth /auth/logout
  app.post("/m/v1/auth/logout", requireAuth, async (c) => {
    const token = bearer(c);
    await deps.auth.post<{ ok: true }, { token: string | null }>(authedCtx(c), "/auth/logout", { token });
    return c.json({ ok: true });
  });

  // ================= me =================
  app.get("/m/v1/me", requireAuth, async (c) => {
    const ctx = authedCtx(c);
    const detail = await deps.identity.get(ctx, `/users/${ctx.userId}`);
    return c.json(detail as Record<string, unknown>);
  });

  // ================= devices (MO3-owned) =================
  app.post("/m/v1/devices", requireAuth, async (c) => {
    const ctx = authedCtx(c);
    const body = await readJson<Partial<mobile.RegisterDeviceRequest>>(c);
    const platform = requirePlatform(body.platform);
    const pushToken = requireString(body.pushToken, "pushToken");
    const { device } = await deps.devices.upsertByToken({ userId: ctx.userId!, platform, pushToken });
    const res: mobile.RegisterDeviceResponse = { deviceId: device.id };
    return c.json(res, 201);
  });

  app.get("/m/v1/devices", requireAuth, async (c) => {
    const ctx = authedCtx(c);
    const recs = await deps.devices.listActiveByUser(ctx.userId!);
    const res: ListDevicesResponse = { devices: recs.map(toDeviceDto) };
    return c.json(res);
  });

  app.delete("/m/v1/devices/:deviceId", requireAuth, async (c) => {
    const ctx = authedCtx(c);
    const deviceId = c.req.param("deviceId");
    const ok = await deps.devices.disableOwned(ctx.userId!, deviceId);
    if (!ok) throw mobileErrors.deviceNotFound(deviceId);
    return c.body(null, 204);
  });

  // ================= BFF aggregates =================
  app.get("/m/v1/bff/home", requireAuth, async (c) => {
    const ctx = authedCtx(c);
    const { home } = await buildHome(deps, ctx, ctx.userId!);
    return c.json(home);
  });

  app.get("/m/v1/bff/events/:eventId", requireAuth, async (c) => {
    const ctx = authedCtx(c);
    const eventId = c.req.param("eventId");
    const res = await buildEventOverview(
      {
        event: deps.event,
        capabilities: (cx, id) =>
          deps.authenticator.capabilities(cx, ctx.userId!, deps.config.defaultOrgId, {
            resourceType: "event",
            resourceId: id,
          }),
      },
      ctx,
      eventId,
    );
    return c.json(res);
  });

  // ================= transparent proxy (logic-free) =================
  app.get("/m/v1/events", requireAuth, (c) => proxy(c, deps.event, "GET", "/events"));
  app.get("/m/v1/events/:id", requireAuth, (c) => proxy(c, deps.event, "GET", `/events/${c.req.param("id")}`));
  app.get("/m/v1/tasks", requireAuth, (c) => proxy(c, deps.task, "GET", "/tasks"));
  app.get("/m/v1/tasks/:id", requireAuth, (c) => proxy(c, deps.task, "GET", `/tasks/${c.req.param("id")}`));
  app.patch("/m/v1/tasks/:id", requireAuth, (c) => proxy(c, deps.task, "PATCH", `/tasks/${c.req.param("id")}`));
  app.patch("/m/v1/actions/:id", requireAuth, (c) => proxy(c, deps.event, "PATCH", `/actions/${c.req.param("id")}`));
  app.get("/m/v1/inbox", requireAuth, (c) => proxy(c, deps.notification, "GET", "/inbox"));
  app.patch("/m/v1/inbox/:id/read", requireAuth, (c) => proxy(c, deps.notification, "PATCH", `/inbox/${c.req.param("id")}/read`));
  app.post("/m/v1/inbox/read-all", requireAuth, (c) => proxy(c, deps.notification, "POST", "/inbox/read-all"));
  app.get("/m/v1/preferences", requireAuth, (c) => proxy(c, deps.notification, "GET", "/preferences"));
  app.patch("/m/v1/preferences", requireAuth, (c) => proxy(c, deps.notification, "PATCH", "/preferences"));

  // ================= STUB: sync / offline mutations (theme14 D2) =================
  app.get("/m/v1/sync", requireAuth, () => {
    throw mobileErrors.notImplemented("/sync");
  });
  app.post("/m/v1/mutations", requireAuth, () => {
    throw mobileErrors.notImplemented("/mutations");
  });

  // ================= internal: push dispatch (Service Binding only) =================
  app.post("/internal/push/dispatch", async (c) => {
    requireInternal(c);
    const ctx = publicCtx(c);
    const body = await readJson<Partial<PushDispatchBody>>(c);
    const userId = requireString(body.userId, "userId");
    const type = requireString(body.type, "type");
    if (!body.payload || typeof body.payload !== "object") {
      throw errors.validationFailed([{ field: "payload", reason: "required" }]);
    }
    const payload = body.payload;
    requireString(payload.title, "payload.title");
    const notificationId = body.notificationId ?? newId("mntf");
    const result = await dispatchPush(
      {
        devices: deps.devices,
        deliveries: deps.deliveries,
        adapters: deps.pushAdapters,
        audit: deps.audit,
        orgId: deps.config.defaultOrgId,
      },
      ctx,
      notificationId,
      { userId, type, payload },
    );
    return c.json(result, 202);
  });

  return app;
}
