// THE authorization surface of file-meta. Every endpoint this Worker serves is listed here
// with the permission keys its caller must hold; `policyGate` (mounted first in app.ts)
// enforces it and nothing else in this service checks permissions. A route added to app.ts
// without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// WHY the keys are `appLevel("driveshare", ...)` and not bare `file:*`:
// APP_MANIFEST's `driveshare` entry (Drive共有) claims the R2 file keys as its own 詳細設定 —
// `detailPermissions: ["drive:read","drive:write","file:read","file:write","file:admin"]`
// (packages/types/src/app-registry.ts). So file-meta IS the file surface of that app, and the
// ロール管理 3-tier set there is supposed to govern it. Before this table it did not: the old
// `requirePermission("file:write")` looked at the fine-grained key ONLY, so a role whose
// Drive共有 tier was 無効 or 閲覧 could still upload, relink and logically delete through this
// API as long as it carried a legacy `file:write`. Each rule now demands BOTH halves (the
// tier AND the fine-grained key) — the stricter reading, and the one an admin setting 無効 in
// ロール管理 expects.
//
// NOT here, by design — the instance-level half of the decision (gate.ts "NOT this layer's
// job"): private-visibility ownership (`file.ownerId === caller` or `file:admin`), the
// per-result private filter on search, and the `file:admin` demand on an `ownerId`
// reassignment all need the LOADED ROW or the request body, so they live in app.ts's handlers
// where the row already is. This table answers "may this caller touch files at all", the
// handlers answer "may they touch THIS file". Both are required; see
// docs/policy-coverage-inventory.md §3(d).
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- internal-only (no gateway route; reachable only over a Service Binding) ----

  // Liveness. INTERNAL, deliberately NOT PUBLIC: its callers are app-health-monitor and the
  // deploy smoke checks, which probe over the SVC_FILE_META binding and attach the full
  // x-dub-* set (x-dub-internal included), so INTERNAL costs the real caller nothing. Before
  // this table the route had NO check at all — not even the marker — which inventory §3(a-9)
  // lists as "unprotected on its own"; api-gateway merely happens not to route /internal/*.
  // PUBLIC would encode that routing accident as an intention; it is not one.
  "GET /internal/health": INTERNAL,

  // Free-tier consumer landing: producers of drive.* / *.archived forward their deferred
  // @dub/freeq outbox envelopes here over their SVC_FILE_META binding. INTERNAL and not
  // `internalWithKeys([...])` because there is no acting user to attribute keys to — the
  // envelope is a system event drained by a cron, so demanding a permission would 401 every
  // legitimate delivery and make the producer's row retry forever.
  //
  // This replaces the hand-rolled `if (!c.req.header(HEADERS.internal)) 404` that used to sit
  // at the top of the handler. Same door, now visible in the table; the refusal is the gate's
  // 403 `internal_only` rather than a 404, which is still non-2xx so a caller's drain keeps
  // the row pending exactly as before.
  "POST /internal/events-async": INTERNAL,

  // ---- reads: Drive共有 閲覧 + file:read ----
  // Visibility is then narrowed per row in the handler (private -> owner or file:admin).
  "GET /files/search": appLevel("driveshare", "view", "file:read"),
  "GET /files/meta/:id": appLevel("driveshare", "view", "file:read"),
  "GET /files/:id/download": appLevel("driveshare", "view", "file:read"),

  // ---- writes: Drive共有 編集 + file:write ----
  // `file:admin` is NOT demanded by any entry: it is the escalation a handler checks for a
  // specific act (reading someone else's private file, reassigning `ownerId`), never a
  // requirement to reach a route. Putting it in the table would lock admins-only out of
  // ordinary writes.
  "POST /files/meta": appLevel("driveshare", "edit", "file:write"),
  "PATCH /files/meta/:id": appLevel("driveshare", "edit", "file:write"),
  "DELETE /files/meta/:id": appLevel("driveshare", "edit", "file:write"),
  "POST /files/meta/:id/links": appLevel("driveshare", "edit", "file:write"),
  "DELETE /files/meta/:id/links": appLevel("driveshare", "edit", "file:write"),
  "POST /files": appLevel("driveshare", "edit", "file:write"),
});
