// THE authorization surface of deploy-service. Every endpoint this Worker serves is listed
// here with the permission keys its caller must hold; `policyGate` (mounted in app.ts before
// any route) enforces it and nothing else in this service checks permissions. A route added
// without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// This is the ecosystem's single strong-privilege executor (Cloudflare Pages deploys, DNS,
// the registrar surface), so the four infra keys are graded on purpose and the table keeps
// that grading visible in one place:
//   infra:read   see sites / deployments / domains        (not dangerous)
//   infra:deploy execute a deployment                     (dangerous)
//   infra:dns    change a DNS record                      (dangerous)
//   infra:admin  register a site / manage allowed zones   (dangerous)
// The three write keys are `dangerous: true` in PERMISSION_CATALOG, which is what preserves
// the old `requirePermission(key, fresh=true)` intent: @dub/policy-gate's granter bypasses
// its decision cache for dangerous keys in BOTH directions (authz-cache.ts), so a revoked
// infra:deploy takes effect on the very next request exactly as before. No route lost its
// `fresh` property in this migration.
import { definePolicyTable, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. INTERNAL, deliberately NOT PUBLIC: the only caller is app-health-monitor
  // (config.ts target "deploy-service", path /health), which probes over the SVC_DEPLOY
  // Service Binding attaching the full x-dub-* set including x-dub-internal
  // (app-health-monitor/src/checks.ts probeBinding), so INTERNAL costs the real caller
  // nothing. PUBLIC would also "work" today because api-gateway routes only /deploy/* here,
  // leaving /health with no gateway route at all — but that is an accident of routing
  // config, not a decision: PUBLIC asserts "the open internet may call this, intentionally",
  // and if a route entry ever changes PUBLIC would silently expose it while INTERNAL still
  // refuses. (The inventory proposed PUBLIC on the "no gateway segment" argument; rule.ts is
  // explicit that a probe is INTERNAL, and the reference service made the same call.)
  "GET /health": INTERNAL,

  // ---- sites ----
  // NOTE on the ロール管理 3-tier: these rules are plain keys, NOT appLevel("lp", ...) as the
  // inventory's 2.16 proposed. Two independent reasons, both load-bearing:
  //   1. APP_MANIFEST deliberately does NOT scope infra:* to the LP管理 app — its entry
  //      carries `detailPermissions: []` with the comment "infra:* governs the whole
  //      デプロイ/DNS surface (not just LP), so those keys stay in 「その他」". Pairing this
  //      service's routes with app:lp:view/edit would make the LP管理 tier authoritative
  //      over a surface the manifest explicitly refused to put under it.
  //   2. app:lp:view / app:lp:edit are granted to role_sys_admin ONLY (identity migration
  //      0009), while 0002 grants infra:read+infra:deploy to maintainer and infra:read to
  //      organizer on purpose. appLevel("lp", ...) would therefore revoke, with no decision
  //      from anyone, every non-admin role's access to this entire service — including the
  //      organizer read path that tests/integration/deploy.test.ts asserts as a 200.
  // So the table reproduces the previous requirement 1:1. Adding the tier is a deliberate
  // access change for the owner to make (and would need app:lp:* granted to the infra roles
  // first), not a side effect of a mechanical migration.
  "POST /deploy/sites": ["infra:admin"],
  "GET /deploy/sites": ["infra:read"],

  // ---- deployments ----
  "POST /deploy/deployments": ["infra:deploy"],
  "GET /deploy/deployments": ["infra:read"],
  "GET /deploy/deployments/:id": ["infra:read"],

  // ---- dns ----
  // The allowed-zone gate stays in the handler: "may this caller change DNS at all" is the
  // key check (here), "is THIS zone in the allow-list" is a resource-instance check that
  // needs the request body, which is the domain layer's job (gate.ts's header).
  "POST /deploy/dns/records": ["infra:dns"],

  // ---- domains / zones ----
  "GET /deploy/domains": ["infra:read"],
});
