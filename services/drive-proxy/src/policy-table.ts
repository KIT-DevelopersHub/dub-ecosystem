// THE authorization surface of drive-proxy. Every endpoint this Worker serves is listed here
// with what its caller must hold; `policyGate` (mounted first in app.ts) enforces it and
// nothing else in this service checks permissions. A route added to app.ts without a line
// here is denied at runtime and turns test/policy-table.test.ts red.
//
// Why `appLevel("driveshare", ...)` and not a bare `["drive:read"]`: drive-proxy has no
// launcher app of its own (it is the Google adapter behind the Drive共有 app — see
// docs/policy-coverage-inventory.md §3(c)), and APP_MANIFEST assigns the `drive:*` keys to
// `driveshare`'s 詳細設定. So the ロール管理 3-tier that governs this surface IS
// `app:driveshare:view` / `:edit`. The old guards checked only the legacy domain key, which
// meant a role set to 無効 or 閲覧 in ロール管理 could still write through this API as long as
// it carried `drive:write` — exactly the hole drive-share-service's table closed. The
// fine-grained key is kept alongside the tier (not replaced by it): dropping `drive:read` /
// `drive:write` would LOOSEN the route relative to the code being replaced.
//
// Resource scope: nothing to carry over. The removed `requirePerm` passed no resourceId to
// identity (`PermissionChecker.check(userId, orgId, permission)`), so there is no
// instance-level decision that silently widens to org-wide here — the migration note in
// gate.ts / inventory b-5 does not apply to this service. Per-file access is Google's own
// ACL on the shared Drive, which this Worker proxies rather than evaluates.
import { definePolicyTable, appLevel, INTERNAL } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // Liveness. INTERNAL, deliberately NOT PUBLIC — and a tightening: this route had NO guard
  // at all (inventory a-9). Its only caller is app-health-monitor (config.ts target
  // "drive-proxy", path /internal/health), which probes over the SVC_DRIVE_PROXY Service
  // Binding with the full x-dub-* set, x-dub-internal included (app-health-monitor
  // src/checks.ts probeBinding). INTERNAL therefore costs the real caller nothing, while
  // PUBLIC would assert "the open internet may call this, intentionally" — untrue here.
  "GET /internal/health": INTERNAL,

  // ---- reads: Drive共有 が 閲覧 以上 + drive:read ----
  // Registration order in app.ts matters for the two /drive/files/:id* routes (Hono matches
  // /embed first); the table is order-independent, but it is written in app.ts order so the
  // two files read as one list.
  "GET /drive/files": appLevel("driveshare", "view", "drive:read"),
  "GET /drive/files/:id/embed": appLevel("driveshare", "view", "drive:read"),
  "GET /drive/files/:id": appLevel("driveshare", "view", "drive:read"),
  "GET /drive/sheets/:id/values": appLevel("driveshare", "view", "drive:read"),

  // ---- writes: Drive共有 が 編集 + drive:write ----
  "POST /drive/files": appLevel("driveshare", "edit", "drive:write"),
  "POST /drive/files/:id/move": appLevel("driveshare", "edit", "drive:write"),
  "POST /drive/files/:id/trash": appLevel("driveshare", "edit", "drive:write"),
  "POST /drive/sheets/:id/values": appLevel("driveshare", "edit", "drive:write"),

  // ---- operations-only: quota self-report + Drive-watch channel lifecycle ----
  // These are the inventory's a-5 routes. They sit under /drive/* so the gateway DOES route
  // them, and at the inventory's baseline commit the in-service `requireInternal` was the
  // only thing between them and the internet. The edge half of that double defence is
  // already in place now — api-gateway's drive route carries
  // `internalOnlyPaths: ["/drive/health/", "/drive/watch"]` (services/api-gateway/src/
  // routes.ts), which 404s them externally — so a-5 needs no further change here; this table
  // is the second layer, now declared instead of hand-rolled.
  //
  // INTERNAL rather than internalWithKeys: no permission key exists for "may operate the
  // Drive-watch plumbing" (there is no infra-style key in the drive domain and the catalog
  // must not grow one for this), and these calls come from scheduled/ops Workers that carry
  // no acting user at all — demanding keys would 401 the legitimate caller. The marker is the
  // whole門 by design, same as before, and no role can reach them from outside.
  "GET /drive/health/quota": INTERNAL,
  "POST /drive/watch": INTERNAL,
  "POST /drive/watch/:channelId/stop": INTERNAL,
});
