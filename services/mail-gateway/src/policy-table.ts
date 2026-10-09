// THE authorization surface of mail-gateway. Every endpoint this Worker's main app serves
// is listed here with what its caller must hold; `policyGate` (mounted first in app.ts)
// enforces it and nothing else in this service checks a permission KEY. A route added to
// app.ts without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// Two disjoint surfaces on one Worker, and the table is what finally makes the difference
// visible in one place:
//   - internal (bare paths, reached over a Service Binding): POST /send, /internal/*,
//     /health/quota. These used to be guarded by a hand-rolled
//     `if (!c.req.header(HEADERS.internal)) throw forbidden(...)` inside four handlers —
//     invisible to any reader asking "what is internal-only here?". They are now the
//     INTERNAL rule form.
//   - external (mounted under /mail, reached through api-gateway): the user-facing mail app
//     plus the mailbox / Email Routing admin console. These used to be `withAuth(key)`
//     (= requireAuth + requirePermission) sprinkled per route group, with the ロール管理
//     3-tier UNENFORCED — a role whose メール app was set to 無効 or 閲覧 could still send
//     through the API as long as it carried the legacy `mail:send` domain key. Every
//     user-facing rule below pairs the tier (via `appLevel`) with the fine-grained key, so
//     the tier is now authoritative server-side.
//
// WHAT IS NOT HERE, deliberately (the 2-layer split of policy-gate's gate.ts header):
// per-account mail scope. `scopeOf` (own mail vs every account's, by `mail:read_all`),
// `ownerOf` (personal flags / scheduled rows) and the owner+status match on
// PATCH|DELETE /mail/scheduled/:id all need the REQUEST's data (which message, whose row),
// so they stay handler-side assertions in app.ts and keep their own tests. The table
// answers only "does this caller hold the key at all".
import { definePolicyTable, appLevel, INTERNAL, PUBLIC } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- liveness ----
  // PUBLIC, and the only PUBLIC route in this service. It is the one route whose sole
  // output is `{status:"ok", service:"mail-gateway"}` — no config, no provider state, no
  // row — and it has carried no guard of any kind (not even an x-dub-internal check) since
  // it was written, so declaring it PUBLIC states the status quo rather than changing it.
  // Note the contrast with drive-share-service, which marks its probe INTERNAL: that is the
  // stricter and generally better answer, and if app-health-monitor is ever the only caller
  // here too this line should follow. Kept PUBLIC per docs/policy-coverage-inventory.md
  // §2.13 so this migration changes authorization for no route in either direction.
  "GET /internal/health": PUBLIC,

  // ---- internal-only self-reports (was: inline `x-dub-internal` checks in the handlers) ----
  // Each exposes operational detail that must not be readable from the internet: readiness
  // names which provider credentials are present, status derives send-health from the
  // send-log, quota reports the configured provider. PUBLIC would "work" (api-gateway routes
  // only /mail/* to this Worker, so these have no gateway route) but that is an accident of
  // routing config, not a decision — INTERNAL is enforced instead of assumed.
  "GET /internal/health/ready": INTERNAL,
  "GET /internal/status": INTERNAL,
  "GET /health/quota": INTERNAL,

  // ---- POST /send: the SYSTEM send port (open-relay guard) ----
  // INTERNAL, and this is the single most important line in the table: a reachable-from-
  // outside mail send endpoint is an open relay. The only legitimate callers are our own
  // Workers over a Service Binding (notification, member-service, email-routing issuance),
  // which carry `x-dub-internal`; api-gateway strips every inbound x-dub-* and never re-adds
  // this one, so the marker cannot be forged from outside.
  //
  // NOT `internalWithKeys(["mail:send"])`, on purpose: most calls here are system-origin and
  // propagate NO user id (a cron drain, a notification fan-out), and internalWithKeys demands
  // an actor — it would 401 exactly the callers this route exists for. The conditional half
  // of the old guard ("IF a user is on the call, that user must hold mail:send, checked
  // fresh") depends on the REQUEST (is a user id present?), which rule.ts's closed vocabulary
  // cannot express, so it stays in the handler as a layer-2 assertion. Removing it instead
  // would let one compromised s2s caller send as any user; see app.ts.
  "POST /send": INTERNAL,

  // ---- user-facing mail app (ロール管理 tier + fine-grained key) ----
  // 編集 on メール + mail:send — anything that puts (or queues) a message on the wire.
  "POST /mail/outbox": appLevel("mail", "edit", "mail:send"),
  "POST /mail/scheduled": appLevel("mail", "edit", "mail:send"),
  "PATCH /mail/scheduled/:id": appLevel("mail", "edit", "mail:send"),
  "DELETE /mail/scheduled/:id": appLevel("mail", "edit", "mail:send"),

  // 閲覧 on メール + mail:read — reads, and the two mutations that only touch the reader's
  // own view of mail they can already see (the read flag of one message; their personal
  // star/archive/trash flags). Both are per-user state, never another account's, which is
  // what makes 閲覧 the right tier rather than 編集 — it is reading, with a bookmark.
  "GET /mail/messages": appLevel("mail", "view", "mail:read"),
  "GET /mail/messages/:id": appLevel("mail", "view", "mail:read"),
  "POST /mail/messages/:id/read": appLevel("mail", "view", "mail:read"),
  "GET /mail/messages/:id/attachments/:attId": appLevel("mail", "view", "mail:read"),
  "GET /mail/sent": appLevel("mail", "view", "mail:read"),
  "GET /mail/sent/:id": appLevel("mail", "view", "mail:read"),
  "GET /mail/sent/:id/attachments/:attId": appLevel("mail", "view", "mail:read"),
  "GET /mail/scheduled": appLevel("mail", "view", "mail:read"),
  "GET /mail/scheduled/:id": appLevel("mail", "view", "mail:read"),
  "GET /mail/threads/:id": appLevel("mail", "view", "mail:read"),
  "GET /mail/flags": appLevel("mail", "view", "mail:read"),
  "POST /mail/flags/:threadId": appLevel("mail", "view", "mail:read"),

  // ---- mail administration: the bare `mail:admin` key, no app tier ----
  // WHY no `appLevel("mail", ...)` here: these are not the メール app's own surface. The
  // shared-mailbox definitions and the Cloudflare Email Routing proxy (issuing
  // @developershub.jp addresses, forwarding rules) are org infrastructure administered from
  // the roster / admin console, and `mail:admin` is their 詳細設定 key in ロール管理. Adding
  // the メール view/edit tier would mean "an admin loses address issuance the moment their
  // メール app is set to 無効", which is a different app's switch deciding this one.
  // `mail:admin` is `dangerous: true` in PERMISSION_CATALOG, so the granter re-asks identity
  // on every request rather than trusting a cached decision.
  "GET /mail/mailboxes": ["mail:admin"],
  "POST /mail/mailboxes/:id": ["mail:admin"],
  "GET /mail/admin/email-routing/addresses": ["mail:admin"],
  "POST /mail/admin/email-routing/addresses": ["mail:admin"],
  "DELETE /mail/admin/email-routing/addresses/:id": ["mail:admin"],
  "GET /mail/admin/email-routing/roster-addresses": ["mail:admin"],
  "GET /mail/admin/email-routing/issued-addresses": ["mail:admin"],
  "POST /mail/admin/email-routing/issued-addresses": ["mail:admin"],
  "PATCH /mail/admin/email-routing/issued-addresses/:id": ["mail:admin"],
  "DELETE /mail/admin/email-routing/issued-addresses/:id": ["mail:admin"],
  "GET /mail/admin/email-routing/rules": ["mail:admin"],
  "POST /mail/admin/email-routing/rules": ["mail:admin"],
  "PATCH /mail/admin/email-routing/rules/:id": ["mail:admin"],
  "DELETE /mail/admin/email-routing/rules/:id": ["mail:admin"],
});

// ───────────────────────────────────────────────────────────────────────────────────────
// THE STANDALONE COMPOSE WORKER IS NOT GATED — a decision, recorded here because here is
// where a reader will look for it.
//
// src/compose.ts / src/standalone.ts are a SECOND Worker off this same package
// (wrangler.standalone.toml, workers_dev = true): a one-page browser send form, with three
// routes:
//
//   GET  /              the compose page      -> would be PUBLIC
//   GET  /healthz       liveness              -> would be PUBLIC
//   POST /compose/send  the send endpoint     -> INEXPRESSIBLE in this vocabulary
//
// POST /compose/send is exclusion e-4 of docs/policy-coverage-inventory.md §3(e). Its door
// is a same-origin check plus a COMPOSE_TOKEN bearer secret, because the Worker is NOT
// behind api-gateway: no session is established, so no x-dub-user-id arrives and there is no
// subject whose permission keys could be looked up. A shared secret is the correct guard for
// that shape, and policy-gate would be strictly WEAKER here (it has no material to judge).
//
// Which leaves no way to mount the gate on that app honestly. `policyGate` denies any route
// absent from its table, so mounting it would require an entry for /compose/send, and the
// only entry that keeps the endpoint working is PUBLIC — a line asserting "the open internet
// may call this, deliberately" about the one route that is actually token-gated. That is the
// failure mode §3(e) singles out as the worst outcome: the reader trusts the table, the
// table lies. So the gate is not mounted on the compose app, the same conclusion (e)-2
// reaches service-wide for app-health-monitor, for the same reason.
//
// THE COST, stated plainly: the standalone app has no `assertRouteCoverage` net. A route
// added to `createComposeApp()` is NOT automatically denied and NOT automatically caught by
// a red test. Therefore ADDING A ROUTE TO src/compose.ts REQUIRES deciding, in that same
// commit, either to gate the compose app or to extend §3(e)'s exclusion list. The existing
// endpoint's guard is tested on its own terms in test/compose.test.ts (cross-origin 403,
// missing / wrong token 401, unset token 500).
