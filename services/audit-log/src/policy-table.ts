// THE authorization surface of audit-log. Every endpoint this Worker serves is listed here
// with what its caller must be or hold; `policyGate` (mounted first in app.ts) enforces it
// and nothing else in this service checks anything. A route added to app.ts without a line
// here is denied at runtime and turns test/policy-table.test.ts red.
//
// The service has two halves and the table is what makes that split legible:
//   - the WRITE half (/internal/*) is service-to-service only. Audit records are produced by
//     other services (sync fail-close) and by the free-tier outbox drain (async ingest);
//     an audit log that anyone could append to is worthless as evidence, so these are
//     INTERNAL — the x-dub-internal marker, which api-gateway strips off every external
//     request and never re-adds (rule.ts), is the whole door.
//   - the READ half (/audit/*) is the admin-facing query surface, gated on `audit:read`.
import { definePolicyTable, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. INTERNAL, deliberately NOT PUBLIC: the only caller is app-health-monitor
  // (config.ts target "audit-log", path /internal/health), which probes over the SVC_AUDIT
  // Service Binding attaching the full x-dub-* set including x-dub-internal
  // (app-health-monitor/src/checks.ts probeBinding), so INTERNAL costs the real caller
  // nothing. PUBLIC would assert "the open internet may call this, intentionally", which is
  // not what this is.
  "GET /internal/health": INTERNAL,

  // ---- write half: service-to-service only ----
  // Synchronous fail-close write. Callers are services recording one of the 5
  // SYNC_AUDIT_ACTIONS before performing a strong operation (deploy-service's write-ahead
  // intent, identity-roster's role changes). The action catalog is still enforced in the
  // handler — that is input validation, not authorization.
  "POST /internal/log": INTERNAL,
  // Async ingest: the landing route the @dub/freeq outbox drain POSTs each due row to.
  // Open action vocabulary (auth.session.login, ...), idempotent by envelope id.
  "POST /internal/audit-async": INTERNAL,

  // ---- read half: the audit query surface ----
  // Plain ["audit:read"] rather than appLevel(...): APP_MANIFEST has NO `audit` app
  // (@dub/types app-registry — audit has no launcher tile; see the inventory's section (c)),
  // and appLevel throws on an unregistered app id at module load. So there is no ロール管理
  // 3-tier to pair the key with here; the catalog key IS the whole requirement, exactly as
  // the old requirePermission("audit:read") expressed it. If an `audit` app is ever added to
  // the manifest, these two lines become appLevel("audit", "view", "audit:read").
  "GET /audit/logs": ["audit:read"],
  "GET /audit/logs/:id": ["audit:read"],
});
