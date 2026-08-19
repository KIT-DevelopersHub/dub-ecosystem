// app-health-monitor Worker bindings. Everything except a couple of vars is optional so the
// liveness probe and unit tests never crash on a partial binding set; every check degrades
// gracefully (a missing service binding => that target reports "down (unbound)", never a throw).
import type { D1Database, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // ---- the hourly poll alarm loop (replaces a cron; the Workers Free 5-cron cap is full) ----
  MONITOR_DO?: DurableObjectNamespace;

  // ---- durable record of the latest per-target status + incident transitions (dub-core D1) ----
  DB?: D1Database;

  // ---- notification fan-out (admin in-app alert via POST /notify, recipientRoles=[admin]) ----
  SVC_NOTIFICATION?: Fetcher;

  // ---- backend services probed over their /health (or /internal/health) via Service Binding.
  //      Names mirror the live free-tier workers; see config.ts SERVICE_TARGETS for the paths. ----
  SVC_IDENTITY?: Fetcher;
  SVC_AUTH?: Fetcher;
  SVC_EVENT?: Fetcher;
  SVC_TASK?: Fetcher;
  SVC_GANTT?: Fetcher;
  SVC_MAIL_GATEWAY?: Fetcher;
  SVC_CHAT?: Fetcher;
  SVC_MEMBER?: Fetcher;
  SVC_USAGE?: Fetcher;
  SVC_FILE_META?: Fetcher;
  SVC_AUDIT?: Fetcher;
  SVC_DEPLOY?: Fetcher;
  SVC_DRIVE_SHARE?: Fetcher;
  SVC_DRIVE_PROXY?: Fetcher;
  SVC_GITHUB_SYNC?: Fetcher;
  SVC_WEBHOOK?: Fetcher;

  // ---- vars / secrets ----
  // Public origin of the fe2 admin SPA (assets Worker). Default = the workers.dev origin.
  FE_ORIGIN?: string;
  // Public origin of the api-gateway (its /healthz is the one publicly-reachable service probe).
  GATEWAY_ORIGIN?: string;
  // Shared secret gating the /internal/monitor/* control routes over the public origin (kick /
  // run / status). A request must carry `x-monitor-token: <token>`. Fail-closed: when this is
  // unset the control routes are denied entirely (the internal marker is NOT accepted on a public
  // origin). This is how CI arms the alarm after deploy.
  MONITOR_ADMIN_TOKEN?: string;

  ENVIRONMENT?: string;
}
