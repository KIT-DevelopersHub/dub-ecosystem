// usage-meter Worker bindings. Everything except DB is optional so the health probe and
// tests never crash on a partial binding set; each collector/alert channel degrades
// gracefully when its binding/secret is absent.
import type { D1Database, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // ---- data ----
  // Shared dub-core D1. usage-meter WRITES only its usage_ namespace (usage_snapshot) and
  // READS mail_send_log (mail_ namespace) for the Resend send count.
  DB?: D1Database;

  // ---- the daily-collection alarm loop (replaces a cron; the 5-cron account cap is full) ----
  METER_DO?: DurableObjectNamespace;

  // ---- service bindings ----
  SVC_IDENTITY?: Fetcher; // authz/check (infra:read) for GET /usage/summary
  SVC_NOTIFICATION?: Fetcher; // admin in-app alert via POST /notify (EVT_NOTIFICATION path)
  SVC_MAIL_GATEWAY?: Fetcher; // admin email alert via POST /send

  // ---- secrets / vars ----
  // Cloudflare GraphQL Analytics token (account-scoped read). Falls back to the shared
  // deploy token CLOUDFLARE_API_TOKEN when the dedicated one is not set.
  USAGE_CF_ANALYTICS_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string; // account tag the GraphQL query filters by

  // Alert routing. Email is the reliable channel (no id resolution). In-app is added when
  // a comma-separated admin user-id list is configured.
  USAGE_ALERT_EMAIL?: string; // default admin@developershub.jp
  USAGE_ALERT_ADMIN_USER_IDS?: string; // csv of user ids -> notification /notify recipients

  ENVIRONMENT?: string;
}

/** The effective Cloudflare Analytics token (dedicated, else the shared deploy token). */
export function cfToken(env: Env): string | null {
  return env.USAGE_CF_ANALYTICS_TOKEN || env.CLOUDFLARE_API_TOKEN || null;
}
