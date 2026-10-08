// THE authorization surface of task-service. Every endpoint this Worker serves is listed
// here with the permission keys its caller must hold; `policyGate` (mounted first in app.ts)
// enforces it and nothing else in this service performs a KEY check. A route added to app.ts
// without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// Each rule pairs the ロール管理 3-tier for マイタスク (`app:tasks:view` / `:edit`, via appLevel)
// with the fine-grained `task:*` key the old `requirePermission` demanded. BOTH halves are
// deliberate, and the fine-grained half is a DEVIATION from the proposal in
// docs/policy-coverage-inventory.md §2.7, which listed the writes as a bare
// `appLevel("tasks","edit")`:
//
//   `keysForAppLevel("tasks","edit")` resolves to ["app:tasks:view","app:tasks:edit"] only —
//   マイタスク's `detailPermissions` (task:read/write/delete) are NOT part of the tier. So a
//   bare `appLevel("tasks","edit")` would have let a role holding the tier but NOT `task:write`
//   write, which today's `requirePermission("task:write")` refuses. That is a weakening, not a
//   migration, so the fine-grained key stays — exactly the shape the reference implementation
//   uses (`appLevel("driveshare","edit","drive:write")`) and the shape §2.7 itself already
//   proposed for DELETE (`appLevel("tasks","edit","task:delete")`).
//
// What the tier ADDS over the old guard: マイタスク set to 無効/閲覧 in ロール管理 now really bites
// on this API, where before a role carrying a legacy `task:write` could still write.
//
// NOT here, by design (see gate.ts "NOT this layer's job" and inventory §3(d)): the checks
// that need the request's DATA — `includeArchived` demanding `task:delete`, the self-scoping of
// a bare `GET /tasks`, `origin` being service-only, the origin=github protected fields, and the
// same-team dependency constraint. Those stay in app.ts's handlers.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. INTERNAL, deliberately NOT PUBLIC — and this closes inventory a-9.
  //
  // The path sits OUTSIDE the old `/internal/*` marker guard, so until now it answered any
  // caller with no check at all. Its only real caller is app-health-monitor, which probes
  // over the SVC_TASK Service Binding and attaches the full x-dub-* set, x-dub-internal
  // included (app-health-monitor/src/{config,checks}.ts), so INTERNAL costs it nothing.
  // api-gateway routes only /tasks/* here, so there is no gateway route to /health today —
  // but that is routing config, not a decision, and PUBLIC would claim we MEANT to publish a
  // probe. INTERNAL refuses it even if a route entry changes.
  "GET /health": INTERNAL,

  // Free-tier consumer landing route: event-service's @dub/freeq drain POSTs each due
  // event.archived envelope here. Replaces the hand-rolled `/internal/*` 404 middleware —
  // the marker check is now the rule itself, so the route is visible in this table instead of
  // being invisible to a reader of it. The drain carries no acting user, which is why this is
  // bare INTERNAL and not `internalWithKeys`.
  "POST /internal/events-async": INTERNAL,

  // ---- reads: マイタスク 閲覧 + task:read ----
  "GET /tasks/dependencies": appLevel("tasks", "view", "task:read"),
  "GET /tasks": appLevel("tasks", "view", "task:read"),
  "GET /tasks/:id": appLevel("tasks", "view", "task:read"),
  "GET /tasks/:id/attachments": appLevel("tasks", "view", "task:read"),

  // ---- writes: マイタスク 編集 + task:write ----
  "POST /tasks": appLevel("tasks", "edit", "task:write"),
  "PATCH /tasks/:id": appLevel("tasks", "edit", "task:write"),
  "POST /tasks/:id/attachments": appLevel("tasks", "edit", "task:write"),
  "DELETE /tasks/:id/attachments/:attachmentId": appLevel("tasks", "edit", "task:write"),
  "PUT /tasks/:id/dependencies": appLevel("tasks", "edit", "task:write"),

  // ---- archive: the one write that needs the higher fine-grained key ----
  // Soft delete, so 編集 + task:delete (which 一般メンバー does not hold — see the role matrix
  // in test/policy-table.test.ts).
  "DELETE /tasks/:id": appLevel("tasks", "edit", "task:delete"),
});
