// THE authorization surface of mail-automation. Every endpoint this Worker serves is listed
// here; `policyGate` (mounted first in app.ts) enforces it and nothing else in this service
// checks authorization. A route added to app.ts without a line here is denied at runtime and
// turns test/policy-table.test.ts red.
//
// WHY EVERY RULE IS AN INTERNAL FORM — the one fact that shapes this whole table:
// api-gateway has NO route segment for this service (there is no `/mailauto/*` entry in its
// routing config), so not one endpoint below is reachable from the internet. Every real
// caller arrives over a Service Binding carrying `x-dub-internal`: the admin UI reaches the
// rules/templates/settings surface through another Worker, and freeq-drain delivers events.
//
// So the 13 actor-bearing routes are "internal-only AND key-gated" = `internalWithKeys`:
//   - plain `["mail:admin"]` would CLAIM the route is externally reachable by any mail admin.
//     It is not, and writing that invites someone to add the gateway segment believing the
//     table already describes the external contract.
//   - plain `INTERNAL` would CLAIM an s2s call needs no permission, so one compromised
//     caller could drive admin-level mutations (kill switch off, rules rewritten) with no
//     acting user's key behind it.
// Both are lies about the route, in the artifact reviewers trust. `internalWithKeys` states
// the conjunction the service actually enforces: the marker opens the door, the key is still
// demanded of the propagated acting user (see packages/policy-gate/src/rule.ts).
//
// Key split mirrors the old per-route `requirePermission` exactly: reads need `mail:read`,
// mutations and the real send path need `mail:admin`. Per the identity migrations that is
// read = admin + maintainer, admin-key = admin only.
import { definePolicyTable, internalWithKeys, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Free-tier event landing (改善#5). freeq-drain POSTs each `evt.mail-automation` envelope
  // here over its SVC_MAIL_AUTOMATION binding with only `content-type` + `x-dub-internal`
  // (services/freeq-drain/src/routing.ts `makeDeliver`).
  //
  // Bare INTERNAL and deliberately NOT `internalWithKeys([...])`: a drained envelope is a
  // SYSTEM-origin delivery with no acting user (`actorId` is null for mail.message.received),
  // and an `internalWithKeys` rule 401s a caller that propagated no user id. Demanding a key
  // here would reject every legitimate delivery and make the producer's freeq row retry
  // until it is declared terminally failed — i.e. silently disable auto-reply.
  //
  // This replaces the hand-rolled `if (!headers.get(x-dub-internal)) 404` that used to sit at
  // the Worker entry (src/index.ts), above the app. Same door, now visible in the table; the
  // refusal is the gate's 403 `internal_only` instead of a 404, which is still non-2xx, so
  // the drain keeps the row pending exactly as before.
  "POST /internal/events-async": INTERNAL,

  // ---- rules ----
  "GET /rules": internalWithKeys(["mail:read"]),
  "POST /rules": internalWithKeys(["mail:admin"]),
  "GET /rules/:id": internalWithKeys(["mail:read"]),
  "PATCH /rules/:id": internalWithKeys(["mail:admin"]),
  "DELETE /rules/:id": internalWithKeys(["mail:admin"]),

  // ---- templates ----
  "GET /templates": internalWithKeys(["mail:read"]),
  "POST /templates": internalWithKeys(["mail:admin"]),
  "PATCH /templates/:id": internalWithKeys(["mail:admin"]),

  // ---- process / dry-run ----
  // /process actually SENDS an auto-reply through mail-gateway, /dry-run only evaluates and
  // writes nothing — hence admin vs read. Not the same rule on purpose.
  "POST /process": internalWithKeys(["mail:admin"]),
  "POST /dry-run": internalWithKeys(["mail:read"]),

  // ---- decisions (audit trail of what the pipeline decided) ----
  "GET /decisions": internalWithKeys(["mail:read"]),

  // ---- settings (automation kill switch) ----
  "GET /settings": internalWithKeys(["mail:read"]),
  "PATCH /settings": internalWithKeys(["mail:admin"]),
});
