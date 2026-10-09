// THE authorization surface of github-sync. Every endpoint this Worker serves is listed here
// with what its caller must carry; `policyGate` (mounted first in app.ts) enforces it and
// nothing else in this service checks permissions or the internal marker. A route added to
// app.ts without a line here is denied at runtime and turns test/policy-table.test.ts red.
//
// WHY PLAIN KEYS AND NOT `appLevel(...)`: there is no `github` entry in APP_MANIFEST
// (`@dub/types` app-registry: events/tasks/gantt/calendar/notifications/chat/mail/usage/
// members/participation/driveshare/lp/admin/commander) and no `app:github:*` key exists in
// PERMISSION_CATALOG. `appLevel("github", ...)` would therefore throw at module load. The
// GitHub連携 surface has no launcher app of its own — it is an integration configured from
// other screens — so the ロール管理 3-tier has nothing to say about it and the fine-grained
// `github:*` keys ARE the whole decision. Registering a new app is a product decision about
// ロール管理's UI (see docs/policy-coverage-inventory.md (c)), not something this migration
// may invent; if `github` is ever added to the manifest, these four rules become
// `appLevel("github", "view"|"edit", "github:...")` and the matrix test below shows the diff.
//
// The four keys are real catalog entries (`@dub/types` identity.ts PERMISSION_CATALOG:
// github:read / github:write / github:sync / github:admin), so no cast is needed — the
// "not in the frozen catalog" note that used to live in the deleted src/auth.ts was stale.
import { definePolicyTable, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- service-to-service only (the `/internal/*` prefix) ----
  // These four replace the hand-rolled `app.use("/internal/*", ...)` marker guard. Same
  // door, now declared: the gate refuses a request without `x-dub-internal`, which
  // api-gateway strips off every external request and never re-adds (so it is unforgeable).
  // None of them demands a key: a liveness probe and a drain delivery have no acting user to
  // attribute one to, which is exactly the difference between INTERNAL and internalWithKeys.
  //
  // NOTE on the status code: the old guard answered 404 (`errors.notFound`) to hide the
  // route's existence; the INTERNAL rule answers 403 `internal_only`. Reachability is
  // identical — `github` is the only gateway segment bound to this Worker
  // (api-gateway routes.ts), so `/internal/*` has no gateway route at all.

  // Liveness, probed by app-health-monitor over the SVC_GITHUB_SYNC binding.
  "GET /internal/health": INTERNAL,
  // Free-tier landing routes: task-service / event-service (domain events) and
  // webhook-ingest (raw GitHub webhooks) drain their @dub/freeq outbox into these, standing
  // in for the dub-q-evt-github-sync / dub-q-wh-github Queue consumers on the free plan.
  "POST /internal/events-async": INTERNAL,
  "POST /internal/webhooks-async": INTERNAL,
  // Arms the GithubReconcileDO alarm once after a free-plan deploy (no cron slot).
  "POST /internal/reconcile/kick": INTERNAL,

  // ---- links: task <-> GitHub issue bindings ----
  "GET /github/links": ["github:read"],
  "POST /github/links": ["github:write"],
  "DELETE /github/links/:id": ["github:write"],

  // ---- repos: which repositories are synced, and how ----
  // Registration / reconfiguration / deregistration are integration administration
  // (installation ids, project numbers, sync direction), so `github:admin` — which the
  // maintainer role deliberately does NOT hold (identity migration 0005), unlike
  // github:read/write/sync.
  "GET /github/repos": ["github:read"],
  "POST /github/repos": ["github:admin"],
  "PATCH /github/repos/:id": ["github:admin"],
  "DELETE /github/repos/:id": ["github:admin"],

  // ---- sync runs ----
  "POST /github/sync": ["github:sync"],
  "GET /github/sync/runs": ["github:read"],
  "GET /github/sync/runs/:id": ["github:read"],
});
