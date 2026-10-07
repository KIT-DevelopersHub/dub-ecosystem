// THE authorization surface of identity-roster. Every endpoint this Worker serves is listed
// here with what its caller must carry; `policyGate` (mounted first in app.ts) enforces it
// and nothing else in this service checks a permission. A route added to app.ts without a
// line here is denied at runtime and turns test/policy-table.test.ts red.
//
// THIS SERVICE IS THE DECISION POINT ITSELF. `POST /authz/check` below is the endpoint every
// other service's `PermissionGranter` calls over a Service Binding, so identity-roster cannot
// use that granter on itself — it would re-enter its own gate for every gated request. It
// passes an IN-PROCESS granter instead (src/in-process-granter.ts); see app.ts for the wiring
// and test/policy-table.test.ts for the test that proves no s2s call happens.
//
// Two rule shapes carry the whole external surface:
//   READS  -> ["identity:read"]. Shared surface: assignee pickers, the gateway's /me
//             fan-out, FE7's roster console. Deliberately NOT gated on the 管理 app tier —
//             doing so would 403 unrelated apps that legitimately read the roster. Opening
//             the 管理 SCREEN is gated by app:admin:view in the shell route guard.
//   WRITES -> appLevel("admin", "edit", "identity:admin"). Both halves matter: the
//             fine-grained key AND ロール管理's 3-tier for the 管理 app, so switching 管理 to
//             閲覧 genuinely denies the write (not just greys the button) even though the
//             role keeps identity:admin.
import { definePolicyTable, appLevel, AUTHENTICATED, INTERNAL, PUBLIC } from "@dub/policy-gate";

/** 管理 (ロール管理 / メール名簿) at 編集 + the fine-grained admin key — every roster write. */
const ADMIN_EDIT = appLevel("admin", "edit", "identity:admin");

/** Roster read: the shared, cross-app read key. */
const ROSTER_READ = ["identity:read"] as const;

export const POLICY_TABLE = definePolicyTable({
  // Liveness. PUBLIC, per docs/policy-coverage-inventory.md §2.3 — and the one route in this
  // table where PUBLIC rather than INTERNAL is the deliberate answer:
  //   - api-gateway registers no segment for a bare `/health` on this Worker, so nothing
  //     external reaches it today, and
  //   - it is an unauthenticated 200 `{ ok, service }` with no roster data in it, which
  //     test/app-auth.test.ts pins ("health is public") as the contract its callers use.
  // Unlike drive-share/usage-meter's `/internal/health` (probed by app-health-monitor over a
  // Service Binding, which always carries the marker), this path is the pre-existing
  // unauthenticated probe shape, so INTERNAL would break a live caller rather than cost it
  // nothing. The route exposes no subject and takes no input — there is nothing to leak.
  "GET /health": PUBLIC,

  // ===================== external reads (/identity/*) =====================
  "GET /identity/orgs": ROSTER_READ,
  "GET /identity/users": ROSTER_READ,

  // SELF-EXCEPTION ROUTE — the one entry that deviates from inventory §2.3, which proposes
  // `["identity:read"]` "+ self 例外はハンドラに残す". Those two cannot both hold: the gate runs
  // BEFORE the handler, so a `["identity:read"]` rule 403s a key-less caller and the handler's
  // self branch becomes dead code. That would be a REGRESSION — today any signed-in user may
  // read their OWN detail without identity:read (test/users.test.ts "allows a user to read
  // their own detail without identity:read"), which is what アカウント設定 relies on.
  //
  // So the table states the truthful entry condition (a session is required, no key is) and
  // the KEY check stays in the handler, where the subject is known — gate.ts's two-layer
  // split: layer 1 "does the caller hold the key at all" is vacuous here precisely because
  // the answer depends on WHOSE record it is, which is request data.
  //
  // rule.ts flags this exact shape ("the path names the subject") as AUTHENTICATED's failure
  // mode, and it is right: without the handler assertion every signed-in user could read
  // every other user's detail. The assertion is therefore MANDATORY, is written in the same
  // commit as this line (app.ts, `ext.get("/users/:id")`), and is pinned by the
  // "self exception" block of test/policy-table.test.ts. Do not delete one without the other.
  // Nothing else in this service may use AUTHENTICATED.
  "GET /identity/users/:id": AUTHENTICATED,

  "GET /identity/roles": ROSTER_READ,
  // Who holds which role — no self exception (inventory §2.3): a user's grants are the roster
  // read, not personal data, so the shared read key decides it.
  "GET /identity/users/:id/roles": ROSTER_READ,
  // Static catalog (PERMISSION_CATALOG). Still key-gated: it is the shape of the whole RBAC
  // model and only ロール管理 surfaces need it.
  "GET /identity/permissions/catalog": ROSTER_READ,

  // ===================== external writes (/identity/*) =====================
  "POST /identity/users/invite": ADMIN_EDIT,
  "POST /identity/users/sync-email-routing/preview": ADMIN_EDIT,
  "POST /identity/users/sync-email-routing": ADMIN_EDIT,
  // The LAST_ADMIN invariant (the last identity:admin holder cannot be disabled / offboarded /
  // stripped) is NOT expressible as a key and stays in the service layer, which is where the
  // admin count is already loaded — the same two-layer rule gate.ts states. This line removes
  // only the key check that used to sit in middleware.
  "PATCH /identity/users/:id": ADMIN_EDIT,
  "POST /identity/users/:id/offboard": ADMIN_EDIT,
  "POST /identity/roles": ADMIN_EDIT,
  "PATCH /identity/roles/:id": ADMIN_EDIT,
  "DELETE /identity/roles/:id": ADMIN_EDIT,
  // PRIVILEGE ESCALATION PATH. Assigning a role is how any permission in the system is
  // granted, so this is the single most dangerous line in the table: it must never be
  // loosened below ADMIN_EDIT, and never acquire a self exception.
  "POST /identity/users/:id/roles": ADMIN_EDIT,
  "DELETE /identity/users/:id/roles/:assignmentId": ADMIN_EDIT,

  // ===================== internal (x-dub-internal) =====================
  // All seven are s2s-only, exactly as the hand-rolled `requireInternal` made them — now
  // visible in the table instead of hiding in a middleware. INTERNAL rather than
  // internalWithKeys for each: the calling service acts on behalf of the SYSTEM, not of a
  // permitted user (auth-service provisioning a first login, notification-service expanding a
  // role for a fan-out triggered by a member with no identity:read, the gateway composing
  // /me). Demanding a key here would break those callers; the marker is what proves the call
  // came from one of our Workers, and api-gateway strips every inbound x-dub-* so it cannot
  // be forged from outside.
  "POST /users/provision": INTERNAL,
  "GET /users/:id": INTERNAL,
  "POST /internal/users/:id/profile": INTERNAL,
  "GET /internal/users": INTERNAL,
  "POST /internal/users/lookup": INTERNAL,

  // The ecosystem's authorization decision point: @dub/policy-gate's `createAuthzGranter`
  // calls this over SVC_IDENTITY for every gated request in every other service. INTERNAL is
  // what keeps it off the internet — an external caller must never be able to ask "does user
  // X hold key K?" (a permission oracle), let alone reach the evaluator at all.
  "POST /authz/check": INTERNAL,
  "GET /internal/users/:id/permissions": INTERNAL,
});
