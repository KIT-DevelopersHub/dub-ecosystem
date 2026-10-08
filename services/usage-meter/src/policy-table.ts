// THE authorization surface of usage-meter. Every endpoint this Worker serves is listed here
// with what its caller must carry; `policyGate` (mounted first in app.ts) enforces it and
// nothing else in this service checks anything. A route added to app.ts without a line here is
// denied at runtime and turns test/policy-table.test.ts red.
//
// The shape of this service: one externally reachable read (the dashboard), and four routes
// that only our own Workers call. The real collection work happens in the MeterDO alarm
// (src/meter-do.ts), which is not an HTTP entry and therefore not in this table.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- the one external route: the 無料枠/課金ガード dashboard read ----
  //
  // Reached through api-gateway (segment "usage", auth=required), which forwards
  // x-dub-user-id. The rule pairs the ロール管理 3-tier for the 無料枠/課金ガード app with that
  // app's one fine-grained key, exactly as the reference table (drive-share-service) pairs
  // `appLevel("driveshare","view")` with `drive:read`.
  //
  // The other caller is api-gateway's `GET /bff/home` aggregation, which fetches this over the
  // SVC_USAGE_METER binding — and propagates the authenticated user id (`RequestContext.userId`
  // -> x-dub-user-id, src/handlers/bff-home.ts), so the key check evaluates the real viewer
  // rather than an anonymous service call. A denied viewer lands in that handler's
  // `Promise.allSettled` partial-error path (the home tile is simply absent), not a 500.
  //
  // DELIBERATELY STRICTER THAN docs/policy-coverage-inventory.md §2.18, which proposes a bare
  // `appLevel("usage","view")` on the grounds that the app is `openToAllAuthenticated` and so
  // the tier alone reproduces today's `requireAuth()`-only behaviour. Three reasons to add
  // `usage:view` instead:
  //   - `usage:view` exists in PERMISSION_CATALOG for precisely this endpoint ("View the
  //     free-tier usage & billing-guard dashboard") and is the usage app's ONLY entry in
  //     `detailPermissions`, i.e. ロール管理 already shows an admin a checkbox for it. Before
  //     this table that checkbox decided nothing — the same unenforced-tier bug the reference
  //     table was written to fix.
  //   - `openToAllAuthenticated` is documented in app-registry.ts as "Documentation of intent;
  //     not an authz decision" — it governs whether the launcher tile is shown, not who may
  //     read the data. drive-share's app carries the same flag and its table still uses
  //     `appLevel`.
  //   - no regression for any real role: identity migration 0007 grants `usage:view` and 0008
  //     grants `app:usage:view` to ALL FOUR system roles (admin / maintainer / organizer /
  //     member), so every role that can read this today still can. What changes is only that
  //     setting 無料枠 to 無効 in ロール管理, or unchecking usage:view, now actually denies.
  //
  // NOT `AUTHENTICATED`, even though that would match today's behaviour byte for byte: rule.ts
  // restricts that form to self-scoped `/me`-shaped routes whose subject is the session itself,
  // and names this exact misuse ("the handler reads or writes anything org-wide, even read-only
  // ... that is appLevel(...) or an explicit key"). This handler returns an org-wide
  // infrastructure snapshot — Cloudflare request/D1 volumes, Resend send counts, how close the
  // account is to each free-tier ceiling — which is not the caller's own data, and
  // AUTHENTICATED would drop it out of ロール管理's control permanently.
  "GET /usage/summary": appLevel("usage", "view", "usage:view"),

  // ---- the four internal routes ----
  //
  // INTERNAL, deliberately NOT PUBLIC, for all four. `workers_dev = false` in both tomls and
  // api-gateway forwards only the `usage` segment, so nothing outside can reach these today
  // whatever the rule says — but that is an observation about routing config, not a decision
  // about the endpoints, and rule.ts names it as the trap: PUBLIC would assert the open
  // internet is MEANT to call them, and would silently expose them the day a route or
  // `workers_dev` entry changes. INTERNAL is enforced rather than merely assumed, and costs the
  // real callers nothing (`@dub/http`'s createServiceClient sets x-dub-internal on every s2s
  // call, and app-health-monitor attaches the full x-dub-* set on every probe).

  // Liveness. Probed by app-health-monitor over the SVC_USAGE binding (config.ts target
  // "usage-meter", path /internal/health), which sends the marker on every probe.
  "GET /internal/health": INTERNAL,

  // Worker root. Returns the literal string "usage-meter" and nothing else, but "it leaks
  // nothing" is not a reason to declare an endpoint open to the internet.
  "GET /": INTERNAL,

  // Arm the MeterDO daily-alarm loop (idempotent; run once after each deploy).
  "POST /internal/meter/kick": INTERNAL,

  // On-demand re-collect + upsert. Runs EVERY collector (Cloudflare GraphQL Analytics + a
  // Resend send-log COUNT) and writes the snapshot, so it is both expensive and a write — the
  // least appropriate route in this service to be lenient about.
  "POST /internal/meter/refresh": INTERNAL,
});
