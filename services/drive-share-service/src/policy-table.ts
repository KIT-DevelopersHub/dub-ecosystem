// THE authorization surface of drive-share-service. Every endpoint this Worker serves is
// listed here with the permission keys its caller must hold; `policyGate` (mounted first in
// app.ts) enforces it and nothing else in this service checks permissions. A route added to
// app.ts without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// Each rule pairs the ロール管理 3-tier (`app:driveshare:view` / `:edit`, via appLevel) with the
// fine-grained Drive key. Both halves matter: the tier is what an admin actually sets per role
// in ロール管理 — before this table it was unenforced here, so a role set to 無効 or 閲覧 could
// still write through the API as long as it carried the legacy `drive:write` key.
import { definePolicyTable, appLevel, AUTHENTICATED, INTERNAL } from "@dub/policy-gate";

// Drive共有 の「設定」 (the Google accounts Drive is accessed as) has its own toggles in
// ロール管理 > Drive共有 > 詳細設定. Reading needs 閲覧 on the app + settings_view; changing (which
// moves every share the org manages) needs 編集 on the app + settings_edit. Migration
// identity/0017 gives both keys to the system admin role only; every other role starts off.
const GOOGLE_ACCOUNT_VIEW = appLevel("driveshare", "view", "drive:settings_view");
const GOOGLE_ACCOUNT_EDIT = appLevel("driveshare", "edit", "drive:settings_edit");

// カレンダー > ミーティング (meetings on the shared Google account): 閲覧/編集 on カレンダー plus the
// ミーティング toggles of ロール管理 > カレンダー > 細かい権限. Migration identity/0019 gives both
// keys to the system admin role only; every other role starts off.
const MEETINGS_VIEW = appLevel("calendar", "view", "calendar:meetings_view");
const MEETINGS_EDIT = appLevel("calendar", "edit", "calendar:meetings_edit");

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
  "GET /driveshare/files/:id/drift": appLevel("driveshare", "view", "drive:read"),

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

  // ---- カレンダー > ミーティング ----
  "GET /meetings": MEETINGS_VIEW,
  "GET /meetings/targets": MEETINGS_VIEW,
  "POST /meetings": MEETINGS_EDIT,
  "POST /meetings/sync": MEETINGS_EDIT,
  "PATCH /meetings/:id": MEETINGS_EDIT,
  "DELETE /meetings/:id": MEETINGS_EDIT,

  // ---- 定例の出席 ----
  // Joining a 定例 from Dub records ONLY the caller's own attendance, and the handler asserts the
  // caller is a current member of the meeting's target (attendance-service join) — the /me shape.
  // Members hold neither カレンダー nor ミーティング keys by default (identity/0008, 0019), and the
  // Meet link is already in their Google Calendar invite, so a key here would only make the
  // attendance record unreachable for the very people it counts.
  "POST /meetings/:id/join": AUTHENTICATED,
  "GET /meetings/me/regulars": AUTHENTICATED,
  // 「Googleと連携」 stores only the CALLER's own Google account id (the state is bound to them).
  "POST /meetings/me/google-link/start": AUTHENTICATED,
  "POST /meetings/me/google-link/callback": AUTHENTICATED,
  // The report and corrections are 人事 data: 人事 閲覧 + hr:read / 人事 編集 + hr:write (identity/0025).
  "GET /meetings/attendance": appLevel("hr", "view", "hr:read"),
  "PUT /meetings/:id/attendance/:date/:userId": appLevel("hr", "edit", "hr:write"),
  // Reading Meet records now, confirming who a participant is, and the threshold: corrections too.
  "POST /meetings/attendance/ingest": appLevel("hr", "edit", "hr:write"),
  "PUT /meetings/attendance/links/:googleUserId": appLevel("hr", "edit", "hr:write"),
  "DELETE /meetings/attendance/links/:googleUserId": appLevel("hr", "edit", "hr:write"),
  "PUT /meetings/attendance/settings": appLevel("hr", "edit", "hr:write"),
});
