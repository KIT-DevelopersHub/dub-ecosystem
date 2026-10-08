// THE authorization surface of the notification service. Every endpoint this Worker serves
// is listed here with what its caller must be or hold; `policyGate` (mounted first in app.ts)
// enforces it and nothing else in this service checks permissions. A route added to app.ts
// without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// ---------------------------------------------------------------------------------------
// WHY THIS TABLE HAS TWO OF (ALMOST) EVERYTHING
// ---------------------------------------------------------------------------------------
// `mountNotif(p)` in app.ts registers the whole notification surface TWICE, once per prefix:
//
//   mountNotif("")              -> POST /notify, GET /inbox, PATCH /preferences, …
//   mountNotif("/notifications") -> POST /notifications/notify, GET /notifications/inbox, …
//
// Both mounts are real, live routers, not an alias: internal Service-Binding callers
// (mobile BFF, usage-meter, freeq-drain) address the BARE paths, while api-gateway is a
// transparent proxy that strips only API_PREFIX and so delivers external
// `/api/v1/notifications/inbox` here as `/notifications/inbox`. See app.ts's mountNotif
// comment for the prod incident that forced the second mount.
//
// The gate keys on the route PATTERN Hono matched, so the two mounts are two distinct
// routes and each needs its own line — a table that listed only one prefix would leave 16
// endpoints with no rule, i.e. denied at runtime (and red in the coverage test). The pairs
// are therefore written out in full below rather than generated, because the table's whole
// value is that a reviewer can read what a given path demands without running code.
//
// SAME RULE ON BOTH SIDES, deliberately: the bare paths are not reachable from outside
// (api-gateway has no route to them, and index.ts refuses any non-Service-Binding request
// other than /internal/health), but "unreachable today" is a routing accident, not a
// decision. Giving the bare twin a weaker rule would mean one compromised internal caller
// could read any user's inbox; giving it the same rule costs a legitimate s2s caller
// nothing, since it propagates the acting user's `x-dub-user-id` anyway.
//
// ---------------------------------------------------------------------------------------
// SELF-SCOPED ROUTES: TWO LAYERS, BOTH REQUIRED
// ---------------------------------------------------------------------------------------
// `/inbox*` and `/preferences` are AUTHENTICATED-shaped (the subject is always the session's
// own user) but they are NOT marked `AUTHENTICATED`: `notif:inbox:self` / `notif:prefs:self`
// are real catalog keys (packages/types identity.ts, seeded to every system role by identity
// migration 0004) and ロール管理 can revoke them, so the table must name them or that control
// is silently lost. The second layer stays in the handler: every query is scoped to
// `c.get("userId")`, which is what makes "my inbox" mean mine. The table answers "may this
// caller use an inbox at all", the handler answers "whose inbox" — see gate.ts's RESOURCE
// SCOPE note. (An older app.ts comment claimed these two keys were absent from
// PERMISSION_CATALOG; that was stale and is gone.)
import { definePolicyTable, appLevel, INTERNAL, PUBLIC } from "@dub/policy-gate";

// The 3-tier levels of the 通知 app (app:notifications:view / :edit), paired with the
// fine-grained notif key each route needs. Named once so the 16 duplicated pairs below
// cannot drift between the bare and the /notifications mount.
const INBOX_SELF = appLevel("notifications", "view", "notif:inbox:self");
const PREFS_SELF_READ = appLevel("notifications", "view", "notif:prefs:self");
const PREFS_SELF_WRITE = appLevel("notifications", "edit", "notif:prefs:self");
const MANAGE_READ = appLevel("notifications", "view", "notif:broadcast_publish");
const MANAGE_WRITE = appLevel("notifications", "edit", "notif:broadcast_publish");
const NOTIF_ADMIN_READ = appLevel("notifications", "view", "notif:admin");
const NOTIF_ADMIN_WRITE = appLevel("notifications", "edit", "notif:admin");

export const POLICY_TABLE = definePolicyTable({
  // ---- liveness. PUBLIC here, unlike every other service's probe ----
  // This is the ONE path index.ts serves without the `host === "svc"` Service-Binding
  // check, precisely so an external uptime probe can reach it over the worker's
  // workers.dev subdomain (which this service must have enabled for the DO-direct
  // realtime WebSocket). So the open internet really is meant to call it, which is what
  // PUBLIC asserts; INTERNAL would be a lie about the deployed topology and would break
  // the probe. It returns a fixed { status, service } literal and touches no state.
  "GET /internal/health": PUBLIC,

  // ---- free-tier domain-event landing route ----
  // freeq-drain forwards each due evt.notification outbox row here over the
  // SVC_NOTIFICATION binding. Registered ONCE at the bare path (the drain addresses it
  // directly), so it has no /notifications twin. Bare INTERNAL, not internalWithKeys: a
  // drained domain event has no acting user to attribute a permission to.
  "POST /internal/events-async": INTERNAL,

  // ---- in-app feedback widget (own gateway segment "feedback", no /notifications twin) ----
  // POST is every signed-in member's: the widget files feedback AS the caller
  // (`userId` comes from the session, the body cannot name a subject). It is NOT
  // `AUTHENTICATED` though — 通知 set to 無効 in ロール管理 should mean no feedback either,
  // and that is exactly what the 閲覧 tier key expresses with no fine-grained key.
  "POST /feedback": appLevel("notifications", "view"),
  // The admin read surface: anyone's feedback, so notif:admin on top of the tier.
  "GET /feedback": NOTIF_ADMIN_READ,
  "PATCH /feedback/:id/read": NOTIF_ADMIN_WRITE,

  // NOT in this table, and correctly so: `GET /ws/:userId`, the DO-direct realtime inbox
  // socket. index.ts routes the upgrade straight to the InboxRoom Durable Object before
  // `app.fetch` is ever called, so it is not a Hono route and the gate never sees it. It
  // authenticates itself — the DO verifies an Origin allow-list plus the short-lived HMAC
  // ws-ticket minted by `GET /inbox/ws-ticket` above, which IS gated here. Header trust is
  // impossible there (the socket bypasses api-gateway), which is why it cannot be a table
  // rule rather than an omission.

  // =====================================================================================
  // mountNotif("") — bare paths, addressed by internal Service-Binding callers
  // =====================================================================================
  // Service-to-service ingest (lane C). Was an inline `x-dub-internal` check in the
  // handler; it is the INTERNAL rule now, so the table shows it instead of hiding it.
  "POST /notify": INTERNAL,
  "POST /release": NOTIF_ADMIN_WRITE,
  // (Re)publishes the curated release back-catalog — a deploy-hook seam, no acting user.
  "POST /internal/seed-releases": INTERNAL,
  "GET /manage": MANAGE_READ,
  "POST /manage/:id/publish": MANAGE_WRITE,
  "POST /manage/publish-batch": MANAGE_WRITE,
  "POST /manage/:id/unpublish": MANAGE_WRITE,
  "POST /manage/unpublish-batch": MANAGE_WRITE,
  "GET /inbox": INBOX_SELF,
  "GET /inbox/ws-ticket": INBOX_SELF,
  "GET /inbox/unread-count": INBOX_SELF,
  "PATCH /inbox/:id/read": INBOX_SELF,
  "PATCH /inbox/:id/unread": INBOX_SELF,
  "POST /inbox/read-all": INBOX_SELF,
  "GET /preferences": PREFS_SELF_READ,
  "PATCH /preferences": PREFS_SELF_WRITE,

  // =====================================================================================
  // mountNotif("/notifications") — the gateway segment, same 16 routes, same 16 rules
  // =====================================================================================
  "POST /notifications/notify": INTERNAL,
  "POST /notifications/release": NOTIF_ADMIN_WRITE,
  "POST /notifications/internal/seed-releases": INTERNAL,
  "GET /notifications/manage": MANAGE_READ,
  "POST /notifications/manage/:id/publish": MANAGE_WRITE,
  "POST /notifications/manage/publish-batch": MANAGE_WRITE,
  "POST /notifications/manage/:id/unpublish": MANAGE_WRITE,
  "POST /notifications/manage/unpublish-batch": MANAGE_WRITE,
  "GET /notifications/inbox": INBOX_SELF,
  "GET /notifications/inbox/ws-ticket": INBOX_SELF,
  "GET /notifications/inbox/unread-count": INBOX_SELF,
  "PATCH /notifications/inbox/:id/read": INBOX_SELF,
  "PATCH /notifications/inbox/:id/unread": INBOX_SELF,
  "POST /notifications/inbox/read-all": INBOX_SELF,
  "GET /notifications/preferences": PREFS_SELF_READ,
  "PATCH /notifications/preferences": PREFS_SELF_WRITE,
});
