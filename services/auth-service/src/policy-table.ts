// THE authorization surface of auth-service. Every endpoint this Worker serves is listed here
// with what its caller must carry; `policyGate` (mounted first in app.ts) enforces it and
// NOTHING else in this service checks authorization. A route added to app.ts without a line
// here is denied at runtime and turns test/policy-table.test.ts red.
//
// WHY THIS TABLE LOOKS UNLIKE EVERY OTHER SERVICE'S — read this before "fixing" it:
// auth-service is the service that ISSUES the session every other table's rules are checked
// against. Six of its twelve routes are `PUBLIC`, and that is the correct answer rather than a
// gap, because of a chicken-and-egg constraint that no rule form can express away:
//
//   api-gateway routes the `auth` segment with `auth="public"` (services/api-gateway/src/
//   routes.ts:26) — the edge deliberately does NOT verify a session before forwarding, and its
//   proxy strips every inbound `x-dub-*` and never re-adds `x-dub-user-id` for a public route
//   (services/api-gateway/src/proxy.ts:20-33). So on these routes there IS no trusted actor
//   header to gate on. `AUTHENTICATED` would 401 them unconditionally; a key rule would 401
//   them unconditionally. Login would be impossible.
//
// So `PUBLIC` here means what rule.ts says it means — "the open internet may call this, and
// that is INTENDED" — and NOT "nobody got around to writing a rule". The difference is the
// whole point of this file, so every PUBLIC entry below names the credential the route
// actually demands and the handler-side defense that enforces it. Those defenses are
// AUTHENTICATION (prove you hold this token / this password), not authorization, which is why
// gate.ts's "no other layer performs a check" rule does not reach them: there is no permission
// key anywhere in them. Do not delete them, and do not mistake them for the double-authz that
// the migration removed.
import { definePolicyTable, INTERNAL, PUBLIC, internalWithKeys } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ======================== liveness ========================
  // INTERNAL, deliberately not PUBLIC — see the note at the bottom of this file on the one
  // place this table departs from docs/policy-coverage-inventory.md 2.2.
  //
  // Its only caller is app-health-monitor (src/config.ts:70, target "auth-service",
  // path "/health"), which probes over the SVC_AUTH Service Binding through `probeBinding`
  // (src/checks.ts:62-68). That helper sets `x-dub-internal: "1"` unconditionally on every
  // probe, so INTERNAL costs the real caller nothing. Nothing else in the repo requests
  // auth-service /health (no test, script or CI job does).
  "GET /health": INTERNAL,

  // ============ deliberately PUBLIC: the session-issuing surface ============
  // These six are reachable from the open internet through api-gateway's `auth` segment, by
  // design. Each one either MINTS, RENEWS or DESTROYS a session, so requiring a session to
  // call it is circular. The credential is in the request body / cookie, and the handler
  // verifies it.

  // The ONLY interactive web login. Unauthenticated by construction: it is where a session
  // comes from. Four handler-side defenses stay, and none of them is a permission check:
  // identity-roster ACTIVE-roster allowlist (the authoritative gate — theme #4), PBKDF2
  // credential verification, an optional ALLOWED_LOGIN_DOMAIN filter, and a per-email +
  // per-IP failure-budget rate limiter that also blunts roster enumeration.
  "POST /auth/password/login": PUBLIC,

  // Self-service password change. PUBLIC because the gateway forwards this with no trusted
  // actor header, so the gate has no subject to evaluate — the SESSION TOKEN in the
  // Authorization header or the dub_session cookie is the credential. The handler proves it
  // (`deps.sessions.verify`, then resolves the caller's own email from identity) AND re-checks
  // the CURRENT password before writing a new one. It can only ever act on the caller's own
  // credential: the subject comes from the verified token, never from the path or body, so
  // there is no privileged subject for a key to protect.
  "POST /auth/password": PUBLIC,

  // Session rotation. The refresh token itself IS the credential (cookie or bearer), and it is
  // validated against KV by `deps.sessions.refresh` — an invalid or revoked token is 401. A
  // caller holding no token gets nothing, so public reachability grants no access.
  "POST /auth/refresh": PUBLIC,

  // Logout. Public on purpose and harmless when unauthenticated: it revokes exactly the
  // session named by the presented token and clears the cookie. With no valid token there is
  // nothing to revoke, and one caller can never log another user out (no subject parameter).
  "POST /auth/logout": PUBLIC,

  // ---- the two routes that LOOK like a backdoor and are not (inventory 3.(a) a-3) ----
  // Both mint a session with no password, so they deserve the suspicion. Neither is gated by
  // this table, because the thing that protects them is not a property of the caller — it is
  // whether the route is ENABLED AT ALL in this environment. Writing a key rule here would be
  // theatre: it would suggest the danger is "the wrong user calls it" when the danger is "this
  // code is enabled in production". That is an env decision, and it is fail-closed:
  //
  //   test-login  — `config.testLoginEnabled` = `DUB_TEST_LOGIN === "1" && !isProduction`
  //                 (env.ts:101). TWO conditions, and `isProduction` derives from
  //                 `env.ENVIRONMENT ?? "production"` (env.ts:95) — an UNSET environment is
  //                 treated as production, so a misconfigured deploy disables the route rather
  //                 than opening it. The handler 403s (AUTH_TEST_LOGIN_DISABLED) when off.
  //   demo-login  — not even REGISTERED unless `DEMO_AUTOLOGIN === "1"` (app.ts), i.e. in
  //                 production the route does not exist (404) and no code path in the Worker
  //                 can log anyone in without a credential. It is also still subject to the
  //                 roster allowlist and is pinned to one fixed account.
  //
  // Do NOT "harden" these by adding a key, and do NOT loosen the env guards. Behaviour is
  // unchanged by this migration, on purpose.
  "POST /auth/test-login": PUBLIC,
  // Conditionally registered — see CONDITIONALLY_REGISTERED_ROUTES below.
  "POST /auth/demo-login": PUBLIC,

  // ==================== service-to-service only ====================
  // Unreachable from outside twice over: api-gateway maps only the `auth` segment to SVC_AUTH,
  // so `/verify`, `/mobile/exchange` and `/internal/*` resolve to no gateway route (404 at the
  // edge), and auth-service itself publishes no hostname (`workers_dev = false`, no `routes`
  // in either wrangler toml). INTERNAL states that intent and ENFORCES it, so neither fact
  // above has to stay true forever for these to be safe.

  // Session verification for api-gateway's edge authn and MO3. No key and no actor: the
  // gateway calls this BEFORE it knows who the caller is (services/api-gateway/src/auth.ts
  // passes a context carrying only a requestId), which is exactly why this is bare INTERNAL
  // and not `internalWithKeys` — demanding an actor here would break every logged-in request.
  "POST /verify": INTERNAL,

  // Mobile login track: MO3 exchanges a native Google auth code for a session. Internal-only
  // and actor-free for the same reason as /verify — no session exists yet.
  "POST /mobile/exchange": INTERNAL,

  // Revocation fan-out, called by identity-roster when a user is disabled/removed. Internal
  // with no key: the CALLER is a service acting on its own authority, and it may legitimately
  // propagate no acting user (e.g. a sync job), so the handler audits `ctx.userId ?? null`.
  "POST /internal/revoke-user": INTERNAL,

  // ================ internal AND key-gated (both axes) ================
  // The most sensitive pair in the service: setting and READING a user's plaintext password.
  // Before this table each handler hand-rolled BOTH halves — `requireInternal(c)` plus an
  // inline `identity.hasPermission(actor, "identity:admin")`. `internalWithKeys` is that exact
  // conjunction as one rule, so neither half was dropped in the move:
  //   marker  -> no external caller can reach these at all, whatever they hold
  //   key     -> the acting admin propagated by api-gateway must hold identity:admin
  // Neither substitutes for the other (rule.ts): an s2s call from a compromised service still
  // fails without the key, and identity:admin does not open the door from outside.
  //
  // The actor really does arrive: api-gateway owns `/api/v1/admin/users/:userId/password`
  // (src/app.ts:58-59), authenticates the session itself, and forwards via
  // `createServiceClient`, which sets `x-dub-internal: "1"` always and `x-dub-user-id` from
  // the context whenever it is set (packages/http/src/client.ts:119-125). Its handler builds
  // that context with the acting admin's id (src/handlers/passwords.ts:72-82), so the gate
  // sees both headers and `c.get("userId")` is the admin. The gate 401s rather than
  // anonymously allowing if a future caller ever forgets the actor.
  "POST /internal/admin/users/:userId/password": internalWithKeys(["identity:admin"]),
  // Plaintext password VIEW (decision B, risk accepted). Same rule as the setter — a read this
  // sensitive is not a weaker operation. Every successful view is audited by the handler.
  "GET /internal/admin/users/:userId/password": internalWithKeys(["identity:admin"]),
});

/**
 * Route keys in POLICY_TABLE that app.ts registers CONDITIONALLY, on an env flag.
 *
 * `assertRouteCoverage` compares the table against `app.routes`, so a route that exists only
 * in some environments would make coverage env-dependent: with `DEMO_AUTOLOGIN` unset the
 * table entry matches no registered route and the test fails as "orphaned".
 *
 * The fix is NOT to drop the route from the table — that would leave a real hole in the
 * configuration where it IS registered (staging), which is the one place it is reachable. It
 * stays listed with its rule, and this constant records WHY its presence varies, so the
 * coverage test can assert the honest thing: the full table in the configuration that
 * registers everything, and the table minus these keys in the configuration that does not.
 * Both directions stay exact in both configurations — nothing is merely skipped.
 */
export const CONDITIONALLY_REGISTERED_ROUTES = ["POST /auth/demo-login"] as const;

// ---- the one deviation from docs/policy-coverage-inventory.md 2.2 ----
// The inventory proposes `PUBLIC` for `GET /health`, reasoning that the `health` segment is not
// registered in api-gateway so the route is externally unreachable. That reasoning is sound but
// it is an observation about ROUTING CONFIG, not a decision about the endpoint — and rule.ts
// names it explicitly as the trap: "Do NOT reach for this [PUBLIC] for a liveness probe or any
// other 'it's only called by us anyway' endpoint: that is INTERNAL, which is enforced rather
// than merely assumed." PUBLIC asserts the open internet is MEANT to call this, which is false
// here, and it would silently expose the probe the day a gateway route entry changes.
// drive-share-service (the reference table) resolves the identical case as INTERNAL for the
// identical reason. The real caller already sends the marker, so this costs nothing.
