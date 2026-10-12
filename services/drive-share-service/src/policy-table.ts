// THE authorization surface of drive-share-service. Every endpoint this Worker serves is
// listed here with the permission keys its caller must hold; `policyGate` (mounted first in
// app.ts) enforces it and nothing else in this service checks permissions. A route added to
// app.ts without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// Each rule pairs the ロール管理 3-tier (`app:driveshare:view` / `:edit`, via appLevel) with the
// fine-grained Drive key. Both halves matter: the tier is what an admin actually sets per role
// in ロール管理 — before this table it was unenforced here, so a role set to 無効 or 閲覧 could
// still write through the API as long as it carried the legacy `drive:write` key.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

// Drive共有 の「設定」 (the Google accounts Drive is accessed as) has its own toggles in
// ロール管理 > Drive共有 > 詳細設定. Reading needs 閲覧 on the app + settings_view; changing (which
// moves every share the org manages) needs 編集 on the app + settings_edit. Migration
// identity/0017 gives both keys to the system admin role only; every other role starts off.
const GOOGLE_ACCOUNT_VIEW = appLevel("driveshare", "view", "drive:settings_view");
const GOOGLE_ACCOUNT_EDIT = appLevel("driveshare", "edit", "drive:settings_edit");

export const POLICY_TABLE = definePolicyTable({
  // Liveness. INTERNAL, deliberately NOT PUBLIC.
  //
  // Its only caller is app-health-monitor (config.ts target "drive-share-service"), which
  // probes over the SVC_DRIVE_SHARE Service Binding and attaches the full x-dub-* set —
  // x-dub-internal included — on every probe (app-health-monitor/src/checks.ts). INTERNAL
  // therefore costs the real caller nothing.
  //
  // PUBLIC would also "work" today, because api-gateway routes only /driveshare/* to this
  // Worker, so /internal/health has no gateway route at all. But that is an accident of
  // routing config, not a decision: if a route entry ever changes, PUBLIC would silently
  // expose the endpoint whereas INTERNAL still refuses it. PUBLIC asserts "the open internet
  // may call this, intentionally", which is not true here — so the rule states what we mean.
  "GET /internal/health": INTERNAL,

  // ---- reads: 閲覧 on Drive共有 + drive:read ----
  "GET /driveshare/files": appLevel("driveshare", "view", "drive:read"),
  "GET /driveshare/files/:id/permissions": appLevel("driveshare", "view", "drive:read"),
  "GET /driveshare/role-grants": appLevel("driveshare", "view", "drive:read"),
  "GET /driveshare/files/:id/role-grants": appLevel("driveshare", "view", "drive:read"),

  // ---- writes: 編集 on Drive共有 + drive:write ----
  "POST /driveshare/files/:id/permissions": appLevel("driveshare", "edit", "drive:write"),
  "PATCH /driveshare/files/:id/permissions/:permId": appLevel("driveshare", "edit", "drive:write"),
  "DELETE /driveshare/files/:id/permissions/:permId": appLevel("driveshare", "edit", "drive:write"),
  "POST /driveshare/files/:id/role-grants": appLevel("driveshare", "edit", "drive:write"),
  "DELETE /driveshare/files/:id/role-grants/:roleId": appLevel("driveshare", "edit", "drive:write"),
  "POST /driveshare/files/:id/role-grants/:roleId/reapply": appLevel("driveshare", "edit", "drive:write"),
  "PUT /driveshare/files/:id/link": appLevel("driveshare", "edit", "drive:write"),

  // ---- the Google accounts themselves: Drive共有 の「設定」 ----
  "GET /driveshare/google-account": GOOGLE_ACCOUNT_VIEW,
  "POST /driveshare/google-account/connect": GOOGLE_ACCOUNT_EDIT,
  "POST /driveshare/google-account/callback": GOOGLE_ACCOUNT_EDIT,
  "POST /driveshare/google-account/active": GOOGLE_ACCOUNT_EDIT,
  "DELETE /driveshare/google-account/accounts/:id": GOOGLE_ACCOUNT_EDIT,
});
