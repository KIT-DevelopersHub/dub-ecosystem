// Hono app — thin HTTP adapter over LpService. The gateway strips API_PREFIX and forwards
// /lp/* here. Every user route goes through the policy gate for the LP管理 app
// (view = read the numbers, edit = issue / pause 流入URL). /lp/internal/visits is the
// public beacon landing: s2s only (x-dub-internal), reached via the gateway's
// POST /api/v1/public/lp-visits which sanitizes + classifies before forwarding.
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, DUB_HEADERS, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import { LpService } from "./service";
import type { AppDeps, IngestVisitRequest, LpDevice, ReqCtx } from "./types";

const DEVICES: ReadonlySet<LpDevice> = new Set(["mobile", "desktop", "bot", "unknown"]);
const FIELD_MAX = 200;

function reqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = ctx?.userId ?? c.req.header("x-dub-user-id");
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId, userId };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

const optStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, FIELD_MAX) : null;

/** Defense in depth: the gateway already sanitized, but this route trusts no shape. */
function parseIngest(body: unknown): IngestVisitRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const visitorKey = optStr(b.visitorKey);
  const device = b.device as LpDevice;
  if (!visitorKey || !DEVICES.has(device)) {
    throw errors.validationFailed([{ field: visitorKey ? "device" : "visitorKey", reason: "invalid" }]);
  }
  return {
    source: optStr(b.source),
    path: optStr(b.path),
    lpVersion: optStr(b.lpVersion),
    referrerHost: optStr(b.referrerHost),
    country: optStr(b.country),
    device,
    visitorKey,
  };
}

export function createApp(deps: AppDeps): Hono {
  const svc = new LpService(deps);
  const app = new Hono();

  app.onError(dubErrorHandler({ service: "lp-analytics" }));
  app.use("*", dubContext({ allowGenerate: true }));

  app.get("/health", (c) => c.json({ status: "ok", service: "lp-analytics" }));

  // ---- internal-only (s2s): external callers get 404, never a hint the route exists.
  app.use("/lp/internal/*", async (c, next) => {
    if (!c.req.header(DUB_HEADERS.internal)) throw errors.notFound("route", c.req.path);
    await next();
  });
  app.post("/lp/internal/visits", async (c) => {
    await svc.ingestVisit(parseIngest(await readJson(c)));
    return c.body(null, 204);
  });

  // ---- user routes (signed-in + LP管理 policy gate) ----
  app.use("/lp/*", async (c, next) => {
    if (c.req.path.startsWith("/lp/internal/")) return next();
    return deps.authz.requireAuth()(c, next);
  });
  const view = deps.authz.requireAppAccess("lp", "view");
  const edit = deps.authz.requireAppAccess("lp", "edit");

  app.get("/lp/stats", view, async (c) => c.json(await svc.getStats(c.req.query())));
  app.get("/lp/visits", view, async (c) => c.json(await svc.listVisits(c.req.query())));
  app.get("/lp/links", view, async (c) => c.json(await svc.listLinks(c.req.query())));
  app.post("/lp/links", edit, async (c) => c.json(await svc.createLink(reqCtx(c), await readJson(c), c.req.query()), 201));
  app.patch("/lp/links/:id", edit, async (c) =>
    c.json(await svc.setLinkActive(c.req.param("id"), await readJson(c), c.req.query())),
  );

  return app;
}
