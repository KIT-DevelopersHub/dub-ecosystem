// THE authorization surface of gantt-service. Every HTTP endpoint this Worker serves through
// Hono is listed here with the permission keys its caller must hold; `policyGate` (mounted
// first in app.ts) enforces it and nothing else in this service performs a KEY check. A route
// added to app.ts without a line here is denied at runtime and turns
// test/policy-table.test.ts red.
//
// TWO LAYERS, and the split matters more here than in most services because gantt is
// EVENT-SCOPED (docs/policy-coverage-inventory.md b-5):
//
//   layer 1, this table — does the caller hold `event:read` AT ALL, and does ロール管理 have
//     ガント at 閲覧/編集 for their role? Static: method + pattern -> keys.
//   layer 2, app.ts's `assertEventScope` — does that `event:read` apply to THIS event? The
//     `PermissionGranter` port takes no resource and will not grow one (gate.ts), so the
//     event-scoped question is asserted in the handler, where the event id is in hand.
//
// Dropping layer 2 would silently widen every route below from "the events you may read" to
// "the whole org", which is a regression, not a migration. Both halves landed in one commit.
import { definePolicyTable, appLevel, INTERNAL, PUBLIC } from "@dub/policy-gate";

/**
 * Non-Hono entry points of this Worker, excluded from the table BY DECISION, not omission
 * (inventory §3(e) e-5). They are not reachable through Hono at all, so `policyGate` never
 * runs for them and `assertRouteCoverage` cannot see them — which is exactly why they are
 * written down here and asserted in test/policy-table.test.ts.
 *
 * `GET /ws/:eventId` is dispatched by src/index.ts straight to the GanttRoom Durable Object
 * before `app.fetch` is reached. Its door is an HMAC-signed, 60-second ws-ticket plus Origin
 * verification, performed by the DO itself — neither a permission key nor the
 * `x-dub-internal` marker, so a table entry could not judge it.
 *
 * THE PRICE, and the invariant it imposes: authorization for the socket happens ONCE, when
 * the ticket is issued. `GET /gantt/ws-ticket` IS in the table, and its rule must stay equal
 * to the chart-read rule — loosen the issuing route and the WS door effectively disappears.
 * The coverage test pins that equality.
 */
export const NON_HONO_ROUTES = ["GET /ws/:eventId"] as const;

export const POLICY_TABLE = definePolicyTable({
  // Liveness, and the one genuinely PUBLIC route in this service — a decision, not laziness.
  // gantt runs with `workers_dev = true` because the realtime WS is DO-direct, and
  // src/index.ts deliberately exempts `/health` from the "host must be svc" guard it applies
  // to every other path ("/health stays public for uptime probes"). So the open internet CAN
  // reach it by design, which is what PUBLIC states. It returns a fixed `{status, service}`
  // literal and touches no binding.
  "GET /health": PUBLIC,

  // Free-tier consumer landing route: task-service / event-service freeq drains POST each due
  // envelope here to purge the DTO cache and reap view rows. Replaces the hand-rolled
  // `/internal/*` 404 middleware — the marker check is the rule itself now, so the route is
  // visible to a reader of this table. A drain carries no acting user, hence bare INTERNAL.
  "POST /internal/events-async": INTERNAL,

  // ---- chart reads: ガント 閲覧 + event:read (scoped to the event in the handler) ----
  "GET /gantt": appLevel("gantt", "view", "event:read"),
  "GET /gantt/dependencies": appLevel("gantt", "view", "event:read"),

  // Per-user view state (zoom / collapsed rows). Self-scoped — the row is keyed by the
  // trusted user id, never the body — so the 閲覧 tier is enough to SAVE it; a 閲覧-only
  // viewer must still be able to set their own zoom.
  //
  // DEVIATION from the §2.6 proposal, which was a bare `appLevel("gantt","view")`: today's
  // `guard()` demands `event:read` on the requested event for these two as well, and dropping
  // it would let anyone with the ガント tier read/write view state for an event they cannot
  // see. Keeping the key (plus the handler's scope assertion) preserves exactly today's
  // protection; the proposal would have reduced it.
  "GET /gantt/views": appLevel("gantt", "view", "event:read"),
  "PUT /gantt/views": appLevel("gantt", "view", "event:read"),

  // Realtime subscription follows chart READ access: this route mints the HMAC ticket the
  // GanttRoom DO accepts, and the DO performs no permission check of its own (§3(e) e-5). So
  // this rule IS the authorization for the WebSocket and must stay identical to `GET /gantt`.
  "GET /gantt/ws-ticket": appLevel("gantt", "view", "event:read"),

  // ---- the one write: persist a bar's window onto the underlying task ----
  // ガント 編集 + task:write. Before this table the route had `requireAuth` ONLY — `guard()`
  // explicitly routed around its own permission check (inventory a-4) on the grounds that
  // task-service would demand `task:write` downstream. Two things were wrong with that: the
  // ガント tier was never consulted, and the EVENT SCOPE was lost, so `task:write` alone let a
  // caller re-schedule tasks of events they cannot read and fan the move out over realtime.
  // The tier + key land here; the event scope is asserted in the handler against the task's
  // own event, BEFORE the write (app.ts).
  "PATCH /gantt/rows/:taskId": appLevel("gantt", "edit", "task:write"),
});
