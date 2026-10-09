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

// Switching the Google account Drive is accessed as moves every share the org manages, so it
// is admin-only: the Drive共有 編集 tier AND identity:admin (system admin; maintainer lacks it).
// The status read is gated the same — it names the account and who connected it.
const GOOGLE_ACCOUNT_ADMIN = appLevel("driveshare", "edit", "drive:write", "identity:admin");

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

  // ---- the Google account itself: admin only ----
  "GET /driveshare/google-account": GOOGLE_ACCOUNT_ADMIN,
  "POST /driveshare/google-account/connect": GOOGLE_ACCOUNT_ADMIN,
  "POST /driveshare/google-account/callback": GOOGLE_ACCOUNT_ADMIN,
});
