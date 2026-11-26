// THE authorization surface of lp-analytics. Every endpoint is listed here; `policyGate` (mounted first
// in app.ts) enforces it and nothing else in this service checks permissions.
//
// LP管理 tiers: VIEW = 数字を見る, EDIT = 流入URL・下書き・応募一覧, PUBLISH = 公開版・本番反映・募集 on/off.
//
// INTERNAL routes are reached over Service Bindings only: the public LP Worker (LP_FLAG) and the
// gateway-owned beacon. api-gateway never forwards /lp/internal/* (404 at the edge) and strips inbound
// x-dub-*, and this Worker has workers_dev = false and no routes, so the marker cannot be forged.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

const VIEW = appLevel("lp", "view");
const EDIT = appLevel("lp", "edit");
const PUBLISH = appLevel("lp", "edit", "lp:publish");

export const POLICY_TABLE = definePolicyTable({
  "GET /internal/health": INTERNAL,

  // ---- public LP Worker / gateway beacon (s2s) ----
  "POST /lp/internal/visits": INTERNAL,
  "POST /lp/internal/events": INTERNAL,
  "GET /lp/internal/publish": INTERNAL,
  "GET /lp/internal/goal-metrics": INTERNAL,
  "GET /lp/internal/proposals": INTERNAL,
  "GET /lp/internal/site-config": INTERNAL,
  "POST /lp/internal/proposals/submit": INTERNAL,
  "GET /lp/internal/sponsor-inquiries": INTERNAL,
  "POST /lp/internal/sponsor-inquiries/submit": INTERNAL,

  // ---- LP管理 ----
  "GET /lp/stats": VIEW,
  "GET /lp/site-traffic": VIEW,
  "GET /lp/insights": VIEW,
  "GET /lp/visits": VIEW,
  "GET /lp/links": VIEW,
  "POST /lp/links": EDIT,
  "PATCH /lp/links/:id": EDIT,
  "GET /lp/publish": VIEW,
  "POST /lp/publish": PUBLISH,
  "GET /lp/site-config": VIEW,
  "PUT /lp/site-config/draft": EDIT,
  "POST /lp/site-config/draft/reset": EDIT,
  "POST /lp/site-config/publish": PUBLISH,
  "GET /lp/proposals": VIEW,
  "POST /lp/proposals/enabled": PUBLISH,
  "POST /lp/proposals/fields": EDIT,
  "GET /lp/proposals/submissions": EDIT,
  "PATCH /lp/proposals/submissions/:id": EDIT,
  // スポンサー募集: 公開 on/off と通知先（チャンネル / チームのメール）は PUBLISH、資料請求の一覧（個人情報）は EDIT。
  "GET /lp/sponsor-inquiries": VIEW,
  "POST /lp/sponsor-inquiries/enabled": PUBLISH,
  "POST /lp/sponsor-inquiries/notify": PUBLISH,
  "GET /lp/sponsor-inquiries/items": EDIT,
  "PATCH /lp/sponsor-inquiries/items/:id": EDIT,
});
