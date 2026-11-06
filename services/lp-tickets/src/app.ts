// Hono app — thin HTTP adapter over TicketService. The gateway strips API_PREFIX and forwards
// /lp/tickets* here; the public LP Worker reaches /lp/internal/tickets* over its service binding.
//
// AUTHZ: none in this file. `policyGate` is mounted first and POLICY_TABLE (src/policy-table.ts) lists
// every route below. Do NOT add a permission check to a route or a handler.
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import { policyGate, type PolicyGateVars } from "@dub/policy-gate";
import { POLICY_TABLE } from "./policy-table";
import { TicketService } from "./tickets";
import type { AppDeps, ReqCtx } from "./types";

type Vars = PolicyGateVars;

/** The gate guarantees userId on key-gated routes; an INTERNAL write must get it from the caller. */
function reqCtx(c: Context): ReqCtx {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  const userId = (c.get("userId") as string | undefined) ?? ctx?.userId;
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId: ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "", userId };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const tickets = new TicketService(deps);
  const app = new Hono<{ Variables: Vars }>();

  app.onError(dubErrorHandler({ service: "lp-tickets" }));
  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: "lp-tickets", table: POLICY_TABLE, granted: deps.authz }));
  app.use("*", dubContext({ allowGenerate: true }));

  app.get("/internal/health", (c) => c.json({ status: "ok", service: "lp-tickets" }));

  // チケット購入 (public LP Worker → service binding). Webhook reads the raw body first:
  // the Stripe signature covers the exact bytes.
  app.get("/lp/internal/tickets", async (c) => c.json(await tickets.getPublic()));
  app.post("/lp/internal/tickets/checkout", async (c) => c.json(await tickets.checkout(await readJson(c))));
  app.post("/lp/internal/tickets/coupon", async (c) => c.json(await tickets.checkCoupon(await readJson(c))));
  app.post("/lp/internal/tickets/preview", async (c) => c.json(await tickets.checkPreview(await readJson(c))));
  app.post("/lp/internal/tickets/confirm", async (c) => c.json(await tickets.confirm(await readJson(c))));
  app.get("/lp/internal/tickets/pass/:token", async (c) => c.json(await tickets.pass(c.req.param("token"))));
  app.post("/lp/internal/tickets/stripe-webhook", async (c) => {
    const raw = await c.req.text();
    return c.json(await tickets.webhook(raw, c.req.header("stripe-signature")));
  });
  // 公開設定の release（lp-analytics → service binding）。本番反映の権限は lp-analytics 側で検査済み。
  app.get("/lp/internal/tickets/release", async (c) => c.json(await tickets.getRelease()));
  app.post("/lp/internal/tickets/release", async (c) => c.json(await tickets.setRelease(reqCtx(c), await readJson(c))));

  // チケット: 販売 on/off は公開切り替えと同じ lp:publish。購入者一覧は個人情報なので edit。
  app.get("/lp/tickets", async (c) => c.json(await tickets.getState()));
  app.post("/lp/tickets/enabled", async (c) => c.json(await tickets.setEnabled(reqCtx(c), await readJson(c))));
  app.post("/lp/tickets/cta", async (c) => c.json(await tickets.setCta(reqCtx(c), await readJson(c))));
  app.post("/lp/tickets/fields", async (c) => c.json(await tickets.setFields(reqCtx(c), await readJson(c))));
  app.post("/lp/tickets/types", async (c) => c.json(await tickets.createType(await readJson(c)), 201));
  app.patch("/lp/tickets/types/:id", async (c) => c.json(await tickets.patchType(c.req.param("id"), await readJson(c))));
  // プレビューのテスト購入トークン（Stripe テストキーの時だけ・1 時間）。
  app.post("/lp/tickets/preview-token", async (c) => c.json(await tickets.issuePreview()));
  app.get("/lp/tickets/orders", async (c) => c.json(await tickets.listOrders(c.req.query())));
  // 全注文の CSV。購入者の個人情報を一度に持ち出せるので lp:publish。
  app.get("/lp/tickets/orders/export", async (c) => {
    const { csv, filename } = await tickets.exportOrders();
    return c.body(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    });
  });
  // 要確認 -> 支払い済み の確定はお金と券を結び付ける操作なので、販売 on/off と同じ lp:publish。
  app.post("/lp/tickets/orders/:id/approve", async (c) => c.json(await tickets.approve(reqCtx(c), c.req.param("id"))));

  // 無料券のクーポン: コードは券と同じ価値を持つので、一覧（コードが見える）も発行・停止も販売 on/off と同じ lp:publish。
  app.get("/lp/tickets/coupons", async (c) => c.json(await tickets.listCoupons()));
  app.post("/lp/tickets/coupons", async (c) => c.json(await tickets.createCoupon(reqCtx(c), await readJson(c)), 201));
  app.patch("/lp/tickets/coupons/:id", async (c) =>
    c.json(await tickets.setCouponActive(reqCtx(c), c.req.param("id"), await readJson(c))),
  );

  return app;
}
