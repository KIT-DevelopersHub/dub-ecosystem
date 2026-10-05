// THE authorization surface of freeq-drain. Every endpoint this Worker serves is listed here;
// `policyGate` (mounted first in app.ts) enforces it and nothing else in this service checks
// anything. A route added to app.ts without a line here is denied at runtime and turns
// test/policy-table.test.ts red.
//
// ALL THREE ROUTES ARE `INTERNAL`, and that is the whole table — this service has no external
// surface at all. freeq-drain does its real work in the DO alarm (src/drain-do.ts); fetch()
// exists only because a Worker needs a default export with a fetch handler, plus the one-shot
// kick that arms the alarm after a deploy.
//
// WHY NOT `PUBLIC` for the health probe and `GET /`:
// `wrangler.toml` sets `workers_dev = false` and api-gateway has no `freeq` segment, so today
// nothing outside can reach this Worker whatever the rule says. But that is an observation
// about routing/deploy config, not a decision about the endpoints — and rule.ts names exactly
// this as the trap ("Do NOT reach for [PUBLIC] for a liveness probe or any other 'it's only
// called by us anyway' endpoint: that is INTERNAL, which is enforced rather than merely
// assumed"). PUBLIC would assert the open internet is MEANT to call these, which is false, and
// it would silently expose them the day a route/`workers_dev` entry changes. INTERNAL costs the
// real callers nothing: `@dub/http`'s `createServiceClient` sets `x-dub-internal` on every s2s
// call, and the kick is already documented as being issued over a Service Binding with that
// marker (`wrangler.toml`, and the pre-existing inline guard this table replaces).
//
// NO RULE HERE NAMES A PERMISSION KEY, by design. This Worker holds no identity binding and
// has nothing a permission could be about: the drain's authority comes from its own bindings,
// not from an acting user. `app.ts` therefore wires a granter that throws if it is ever called
// — a loud wiring bug rather than a silent allow — and adding a key-gated route to this table
// means wiring a real granter in the same commit.
import { definePolicyTable, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. No automated prober binds this Worker today (it is absent from
  // app-health-monitor's SERVICE_TARGETS), so the only callers are operators over a Service
  // Binding — which is precisely what INTERNAL says.
  "GET /internal/health": INTERNAL,

  // Worker root. Returns the literal string "freeq-drain" and nothing else, but "it leaks
  // nothing" is not a reason to declare it open — see the header.
  "GET /": INTERNAL,

  // Bootstrap the DO alarm loop (idempotent; safe after every deploy).
  //
  // The old inline guard compared the marker's VALUE (`x-dub-internal !== "1"` -> 403); the
  // gate presence-checks it instead. That difference is deliberate and not a loosening:
  //   - `@dub/http`'s contract for this header is presence-only (gate.ts / rule.ts), so the
  //     value check was stricter than the protocol it was checking, and a future legitimate
  //     caller sending a different non-empty value would have been refused.
  //   - the marker is unforgeable from OUTSIDE regardless of value, because api-gateway strips
  //     every inbound `x-dub-*` and never re-adds this one. Anyone who can set the header at
  //     all is already a Worker of ours, and such a caller could set the exact value just as
  //     easily — so the value never bought a single bit of real defense.
  //   - keeping it would mean a second authorization check outside the table, which is the one
  //     thing a gated service must not have (gate.ts "THE RULE").
  "POST /internal/drain/kick": INTERNAL,
});
