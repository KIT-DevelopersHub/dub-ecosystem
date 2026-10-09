// THE authorization surface of event-service. Every endpoint this Worker serves is listed
// here with the permission keys its caller must hold; `policyGate` (mounted first in app.ts)
// enforces it and nothing else in this service performs a KEY check. A route added to app.ts
// without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// Each rule pairs the ロール管理 3-tier (`app:events:view` / `:edit`, via appLevel) with the
// fine-grained event key the old `requirePermission(...)` middleware asked for. Both halves
// matter: the tier is what an admin actually sets per role in ロール管理 — before this table it
// was unenforced here, so a role whose イベント app is set to 無効 or 閲覧 could still write
// through the API as long as it carried the legacy `event:write` key.
//
// ── TWO LAYERS, AND WHAT THIS FILE IS *NOT* (policy-gate b-5 / gate.ts "RESOURCE SCOPE") ──
// The old middleware asked identity a RESOURCE-SCOPED question on 12 of these routes:
// `requirePermission("event:read", () => ({ resourceType: "event", resourceId: <:id> }))`.
// `PermissionGranter` takes no resource and will not be extended to take one, so this table
// can only express the TYPE-level half ("does the caller hold `event:read` at all").
// The INSTANCE-level half ("…on event X") stays in the handler, where the row is already
// loaded: `EventService.loadEvent` / `loadAction` reject an id outside the caller's org with
// an existence-hiding 404, and the body-dependent `event:admin` demand on a backward phase
// transition is asserted in `EventService.updateEvent` with the event scope attached. Both
// are covered by test/policy-table.test.ts in the same commit as this table.
//
// ── READ THIS BEFORE COPYING THE PATTERN: what the key half of these rules CANNOT see ──
// identity's evaluator (`services/identity-roster/src/authz.ts` `evaluate`) matches an
// UNSCOPED query against ORG-WIDE assignments only: a query with `resourceType === null`
// fails both branches for an assignment carrying `resourceType === "event"`. policy-gate's
// granter (`packages/policy-gate/src/authz.ts`) always sends `checks: [{ permission }]` with
// no resource. So every rule below is an ORG-WIDE question, which has two consequences:
//   1. SAFE DIRECTION — the table can never be *wider* than the guard it replaces. Passing a
//      rule here proves an org-wide grant, and `evaluate` returns true for an org-wide grant
//      whatever the query's scope. So dropping `resourceId` from these 12 routes narrows,
//      never widens (the direction b-5 warns about does not arise in this service).
//   2. THE COST — it narrows for real. A role assigned with the fe7 ScopePicker's event scope
//      (`apps/fe7-admin-roster/src/lib/scope.ts` → `POST /identity/users/:id/roles` with
//      `resourceType: "event"`) grants NOTHING org-wide, so such a caller is now refused by
//      the gate before any handler runs. No rule form can preserve that: any key-bearing rule
//      asks the org-wide question, and the key-free forms (PUBLIC / AUTHENTICATED) are wrong
//      for routes whose path names the target event. Event-scoped role assignment therefore
//      stops conferring access on event-service — a deliberate, owner-visible trade, not an
//      oversight. Do not "fix" it by loosening a rule below.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. INTERNAL, deliberately NOT PUBLIC.
  //
  // Its only caller is app-health-monitor (config.ts target "event-service"), which probes
  // over the SVC_EVENT Service Binding and attaches the full x-dub-* set — x-dub-internal
  // included — on every probe (app-health-monitor/src/checks.ts). INTERNAL therefore costs
  // the real caller nothing.
  //
  // PUBLIC would also "work" today, because api-gateway routes only /events/* and /actions/*
  // to this Worker (`services/api-gateway/src/routes.ts`), so /health has no gateway route at
  // all. But that is an accident of routing config, not a decision: if a route entry ever
  // changes, PUBLIC would silently expose the endpoint whereas INTERNAL still refuses it.
  // PUBLIC asserts "the open internet may call this, intentionally", which is not true here.
  "GET /health": INTERNAL,

  // ---- events: 閲覧 on イベント + event:read / 編集 + event:write ----
  "GET /events": appLevel("events", "view", "event:read"),
  "POST /events": appLevel("events", "edit", "event:write"),
  "GET /events/:id": appLevel("events", "view", "event:read"),
  // event:write is the gate. A BACKWARD phase transition additionally demands event:admin,
  // which depends on the request BODY (and is asked WITH the event scope) — so it is not
  // expressible here and lives in EventService.updateEvent. See the header's two-layer note.
  "PATCH /events/:id": appLevel("events", "edit", "event:write"),
  // Archive is the one event-level destructive op: event:admin, not event:write.
  "DELETE /events/:id": appLevel("events", "edit", "event:admin"),
  "GET /events/:id/participants": appLevel("events", "view", "event:read"),

  // ---- per-event free-form detail store ----
  "GET /events/:id/details": appLevel("events", "view", "event:read"),
  "PUT /events/:id/details": appLevel("events", "edit", "event:write"),

  // ---- shared section layout (order/visibility of the detail sections) ----
  "GET /events/:id/section-layout": appLevel("events", "view", "event:read"),
  "PUT /events/:id/section-layout": appLevel("events", "edit", "event:write"),

  // ---- shared page layout (the block-editor doc for the event hub page) ----
  "GET /events/:id/page-layout": appLevel("events", "view", "event:read"),
  "PUT /events/:id/page-layout": appLevel("events", "edit", "event:write"),

  // ---- actions under an event ----
  "GET /events/:id/actions": appLevel("events", "view", "event:read"),
  "POST /events/:id/actions": appLevel("events", "edit", "event:write"),

  // ---- actions addressed directly by action id ----
  // The client names an ACTION id here, not an event id, so the old middleware passed no
  // resource scope at all (docs/policy-coverage-inventory.md 2.5 "スコープ無し"). The instance
  // layer is `EventService.loadAction`, which resolves the action's PARENT event and 404s when
  // that event is outside the caller's org — the containment check this table cannot express.
  "GET /actions/:id": appLevel("events", "view", "event:read"),
  "PATCH /actions/:id": appLevel("events", "edit", "event:write"),
  // Archiving an action stays at event:write (NOT event:admin like DELETE /events/:id). That
  // asymmetry is pre-existing behaviour, preserved deliberately: tightening it here would
  // lock organisers out of their own actions, which is a product decision, not a migration.
  "DELETE /actions/:id": appLevel("events", "edit", "event:write"),
});
