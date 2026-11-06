// Hono app — thin HTTP adapter over LpService. The gateway strips API_PREFIX and forwards
// /lp/* here. /lp/internal/visits is the public beacon landing, reached via the gateway's
// POST /api/v1/public/lp-visits which sanitizes + classifies before forwarding.
//
// AUTHZ: none in this file. `policyGate` is mounted first and POLICY_TABLE (src/policy-table.ts)
// lists every route below. Do NOT add a permission check to a route or a handler.
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import { policyGate, type PolicyGateVars } from "@dub/policy-gate";
import { POLICY_TABLE } from "./policy-table";
import { LpService } from "./service";
import { ProposalService } from "./proposals";
import { SiteConfigService } from "./site-config";
import type { AppDeps, IngestVisitRequest, LpDevice, ReqCtx } from "./types";

const DEVICES: ReadonlySet<LpDevice> = new Set(["mobile", "desktop", "bot", "unknown"]);
const FIELD_MAX = 200;

function reqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const requestId = ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
  const userId = (c.get("userId") as string | undefined) ?? ctx?.userId ?? c.req.header("x-dub-user-id");
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

/** Optional body: empty → {}. */
async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
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

export function createApp(deps: AppDeps): Hono<{ Variables: PolicyGateVars }> {
  const svc = new LpService(deps);
  const proposals = new ProposalService(deps);
  const siteConfig = new SiteConfigService(deps);
  const app = new Hono<{ Variables: PolicyGateVars }>();

  app.onError(dubErrorHandler({ service: "lp-analytics" }));
  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: "lp-analytics", table: POLICY_TABLE, granted: deps.authz }));
  app.use("*", dubContext({ allowGenerate: true }));

  app.get("/internal/health", (c) => c.json({ status: "ok", service: "lp-analytics" }));

  // ---- internal-only (s2s) ----
  app.post("/lp/internal/visits", async (c) => {
    await svc.ingestVisit(parseIngest(await readJson(c)));
    return c.body(null, 204);
  });
  // The public LP Worker asks which version to serve (service binding, x-dub-internal only;
  // no user / request id needed). Read-only, one row.
  app.get("/lp/internal/publish", async (c) => c.json({ versionId: (await svc.getPublish()).versionId }));
  // 目標管理 (member-service) が月の訪問者数を読む。件数だけ。
  app.get("/lp/internal/goal-metrics", async (c) => {
    const month = c.req.query("month");
    if (!month || !/^\d{4}-\d{2}$/.test(month)) throw errors.validationFailed([{ field: "month", reason: "invalid" }]);
    const total = await deps.repo.total({ orgId: deps.orgId, from: `${month}-01`, to: `${month}-31`, includeBots: false });
    return c.json({ visitors: total.uniques });
  });
  // 登壇者募集 (public LP Worker → service binding).
  app.get("/lp/internal/proposals", async (c) => c.json(await proposals.getPublic()));
  // 公開設定の layout（public LP Worker → service binding）。下書きと本番の両方を返す。
  app.get("/lp/internal/site-config", async (c) => c.json(await siteConfig.getInternal()));
  app.post("/lp/internal/proposals/submit", async (c) => c.json(await proposals.submit(await readJson(c)), 201));

  // ---- user routes ----
  app.get("/lp/stats", async (c) => c.json(await svc.getStats(c.req.query())));
  app.get("/lp/site-traffic", async (c) => c.json(await svc.getSiteTraffic(c.req.query())));
  app.get("/lp/visits", async (c) => c.json(await svc.listVisits(c.req.query())));
  app.get("/lp/links", async (c) => c.json(await svc.listLinks(c.req.query())));
  app.post("/lp/links", async (c) => c.json(await svc.createLink(reqCtx(c), await readJson(c), c.req.query()), 201));
  app.patch("/lp/links/:id", async (c) =>
    c.json(await svc.setLinkActive(c.req.param("id"), await readJson(c), c.req.query())),
  );
  app.get("/lp/publish", async (c) => c.json(await svc.getPublish()));
  app.post("/lp/publish", async (c) => c.json(await svc.setPublish(reqCtx(c), await readJson(c))));

  // 公開設定: 下書きの保存・リセットは edit（本番に効かない）。本番反映は公開版切り替えと同じ lp:publish。
  app.get("/lp/site-config", async (c) => c.json(await siteConfig.getState()));
  app.put("/lp/site-config/draft", async (c) => c.json(await siteConfig.saveDraft(reqCtx(c), await readJson(c))));
  app.post("/lp/site-config/draft/reset", async (c) => c.json(await siteConfig.resetDraft(reqCtx(c), await readBody(c))));
  app.post("/lp/site-config/publish", async (c) => c.json(await siteConfig.publish(reqCtx(c), await readJson(c))));

  // 登壇者募集: 募集 on/off は公開版切り替えと同じ lp:publish。応募一覧は個人情報なので edit。
  app.get("/lp/proposals", async (c) => c.json(await proposals.getState()));
  app.post("/lp/proposals/enabled", async (c) => c.json(await proposals.setEnabled(reqCtx(c), await readJson(c))));
  app.post("/lp/proposals/fields", async (c) => c.json(await proposals.setFields(reqCtx(c), await readJson(c))));
  app.get("/lp/proposals/submissions", async (c) => c.json(await proposals.list(c.req.query())));
  app.patch("/lp/proposals/submissions/:id", async (c) =>
    c.json(await proposals.setStatus(reqCtx(c), c.req.param("id"), await readJson(c))),
  );

  return app;
}
