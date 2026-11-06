// THE authorization surface of lp-tickets. Every endpoint is listed here; `policyGate` (mounted first
// in app.ts) enforces it and nothing else in this service checks permissions.
//
// The three LP管理 tiers are the same ones lp-analytics applies to its own routes:
//   VIEW = read the numbers, EDIT = 券種・入力項目・購入者一覧, PUBLISH = 販売 on/off・クーポン・要確認の確定.
//
// INTERNAL routes are reached over Service Bindings only: the public LP Worker (LP_TICKETS) and
// lp-analytics (SVC_LP_TICKETS, 公開設定の release). api-gateway never forwards /lp/internal/* (404 at
// the edge) and strips inbound x-dub-*, and this Worker has workers_dev = false and no routes, so the
// marker cannot be forged. The Stripe webhook is INTERNAL too: Stripe calls the public LP, the LP Worker
// forwards it over the binding, and TicketService.webhook verifies the signature over the raw bytes.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

const VIEW = appLevel("lp", "view");
const EDIT = appLevel("lp", "edit");
const PUBLISH = appLevel("lp", "edit", "lp:publish");

export const POLICY_TABLE = definePolicyTable({
  "GET /internal/health": INTERNAL,

  // ---- public LP Worker / lp-analytics (s2s) ----
  "GET /lp/internal/tickets": INTERNAL,
  "POST /lp/internal/tickets/checkout": INTERNAL,
  "POST /lp/internal/tickets/coupon": INTERNAL,
  "POST /lp/internal/tickets/preview": INTERNAL,
  "POST /lp/internal/tickets/confirm": INTERNAL,
  "POST /lp/internal/tickets/stripe-webhook": INTERNAL,
  "GET /lp/internal/tickets/release": INTERNAL,
  "POST /lp/internal/tickets/release": INTERNAL,

  // ---- LP管理 ----
  "GET /lp/tickets": VIEW,
  "POST /lp/tickets/enabled": PUBLISH,
  "POST /lp/tickets/cta": PUBLISH,
  "POST /lp/tickets/fields": EDIT,
  "POST /lp/tickets/types": EDIT,
  "PATCH /lp/tickets/types/:id": EDIT,
  "POST /lp/tickets/preview-token": EDIT,
  "GET /lp/tickets/orders": EDIT,
  "POST /lp/tickets/orders/:id/approve": PUBLISH,
  "GET /lp/tickets/coupons": PUBLISH,
  "POST /lp/tickets/coupons": PUBLISH,
  "PATCH /lp/tickets/coupons/:id": PUBLISH,
});
