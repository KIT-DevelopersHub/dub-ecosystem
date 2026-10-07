// THE authorization surface of api-gateway — and ONLY of the routes api-gateway serves
// ITSELF. `policyGate` (mounted in app.ts) enforces it and nothing else in this service
// checks permissions. A gateway-owned route added to app.ts without a line here is denied at
// runtime and turns test/policy-table.test.ts red.
//
// ── SCOPE: why the ~310 downstream routes are NOT here ──────────────────────────────────
// api-gateway proxies everything else under /api/v1/* to a Service Binding. Those routes are
// deliberately absent: each downstream service owns its own table (drive-share-service is the
// reference), so the authorization decision for a route lives in exactly ONE place. Listing
// them here too would mean the gateway had to know every service's permission model —
// two artifacts to keep in sync, with a silent "the edge allows, the service denies" (or far
// worse, the reverse) whenever they drift. The gateway's job on a proxied request is
// authentication plus transport: verify the session, stamp the trusted x-dub-user-id, strip
// anything spoofed, forward. The decision happens downstream.
//
// ── THE CATCH-ALL: `app.all(API_PREFIX + "/*")` and why it is not in this table ──────────
// `docs/policy-coverage-inventory.md` 4.4 bans `app.all()` for ENDPOINTS, because Hono
// records it exactly like an `app.use()` mount (method ALL, path ending in `/*`) and
// `routes.ts`'s `isMiddlewareMount` therefore cannot tell the two apart — an endpoint
// registered that way would skip the gate unnoticed. That ban is the right default and the
// proxy mount is the one deliberate exception:
//
//   1. It is a MOUNT, not an endpoint. It makes no authorization decision and serves no
//      resource of its own; it hands the request to the service that owns the decision.
//      `isMiddlewareMount` classifying it as middleware is the correct answer here, not an
//      accident we are exploiting: for a request that only matches the catch-all,
//      `matchedRouteKey` returns null, the gate calls next(), and the proxy forwards. A
//      gateway-owned route (concrete method, e.g. `GET /api/v1/me`) always wins that same
//      lookup, so owned routes stay fail-closed while the pass-through stays open.
//   2. The alternative is a LIE in the table. Registering it per-method
//      (`app.on(["GET","POST",...])`) would demand entries like `"GET /api/v1/*"`, and the
//      only rule form that would let a proxied request through is PUBLIC — i.e. the table
//      would assert "the open internet may call anything under /api/v1", which is both false
//      and indistinguishable from "every route is public". The honest rule ("the downstream
//      service decides") does not exist in the vocabulary, and adding a sixth form to
//      describe a transport hop is not a rule about a door (see rule.ts: the vocabulary is
//      closed by design).
//   3. The risk 4.4 actually warns about is machine-checked instead of trusted: the
//      "deliberate ALL mounts" test in test/policy-table.test.ts pins the exact set of
//      ALL-method registrations, so a future `app.all("/api/v1/thing", handler)` endpoint
//      fails CI by name rather than silently slipping past the gate.
//
// Keys are written as the FULL external path (`/api/v1/...`), verbatim as registered — not
// composed from API_PREFIX — so a reviewer reads the URL a browser actually calls. Drift is
// impossible to ship: assertRouteCoverage compares these keys against the router, whose
// mounts DO derive from API_PREFIX.
import { definePolicyTable, AUTHENTICATED, PUBLIC } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- PUBLIC: the open internet, by decision ----
  // Liveness. PUBLIC and not INTERNAL (the usual answer for a probe) because this one is
  // genuinely called from outside: uptime checks and `pnpm verify:live` hit
  // https://api.developershub.jp/healthz without any binding. It returns only
  // { status, version, requestId } — no org data, nothing enumerable.
  "GET /healthz": PUBLIC,

  // The LP's two unauthenticated forms. These are the only write paths in the whole system
  // reachable with no session, and that is the product requirement: a prospective member
  // fills in 参加届 / 問い合わせ before they have an account. Bot defense is Turnstile plus
  // the IP rate limiter, which are NOT authorization and stay in the handlers — the gate has
  // nothing to decide here beyond "no session needed".
  //
  // CAVEAT (inventory a-2, deliberately NOT changed in this commit): participation verifies
  // Turnstile only when `TURNSTILE_SECRET && p.turnstileToken` are BOTH truthy, so a client
  // that omits the token skips the check. That is a Turnstile-wiring weakness, not a policy
  // one — PUBLIC states the intent correctly either way, and tightening it would risk
  // breaking the live LP form. See the report / a-2 for the recommended fix.
  "POST /api/v1/public/inquiries": PUBLIC,
  "POST /api/v1/public/participation": PUBLIC,

  // ---- AUTHENTICATED: the /me family (7) ----
  // Self-scoped in the strict sense rule.ts requires: not one of these paths has a subject
  // segment, and every handler takes the user id from the SESSION the gate verified
  // (`c.get("authed")`), never from the path, query or body. So "may I read/write this
  // person's data?" cannot even be asked about someone else, and there is no privileged
  // subject left for a permission key to protect. They stay reachable for every signed-in
  // member by design — these are アカウント設定 and the home dashboard, not org-wide surface.
  //
  // What makes that true per route (each forwards scoped to the session id):
  //   /me              identity master + the caller's own effective permissions
  //   /bff/home        home aggregation; every upstream is called with the caller's id and
  //                    authorizes independently (/tasks?assigneeId=<self>, inbox, usage)
  //   /me/password     auth-service re-derives the user from the forwarded session token and
  //                    re-checks the CURRENT password before rotating — no target id exists
  //   /me/profile      identity /internal/users/<session id>/profile (表示名/アバター only)
  //   /me/participation member-service /members/internal/me/participation (own 参加届)
  // If any of these ever grows a `:userId`, a `?userId=` or a body target, AUTHENTICATED
  // stops being the right rule that same commit.
  "GET /api/v1/me": AUTHENTICATED,
  "GET /api/v1/bff/home": AUTHENTICATED,
  "POST /api/v1/me/password": AUTHENTICATED,
  "GET /api/v1/me/profile": AUTHENTICATED,
  "POST /api/v1/me/profile": AUTHENTICATED,
  "GET /api/v1/me/participation": AUTHENTICATED,
  "POST /api/v1/me/participation": AUTHENTICATED,

  // ---- keys: the admin password pair (the one privileged surface the gateway owns) ----
  // The exact opposite shape of /me/password above: the subject is `:userId`, supplied by the
  // caller, so every signed-in user would otherwise be able to act on every other user.
  // identity:admin is what the inline requireAdmin() demanded before this table; the check
  // now happens once, in the gate, against identity's /authz/check (the GET additionally
  // returns a user's plaintext password, which auth-service audits on every view).
  "POST /api/v1/admin/users/:userId/password": ["identity:admin"],
  "GET /api/v1/admin/users/:userId/password": ["identity:admin"],
});
