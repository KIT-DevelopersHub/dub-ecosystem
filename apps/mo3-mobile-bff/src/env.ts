// Worker bindings + derived runtime config for MO3 mobile-bff.
// D1 (mobile_* namespace) + audit Queue + 5 Service Bindings. Push provider
// credentials are Workers Secrets (interface-frozen, stubbed in P0 — theme8/8-9).
import type { D1Database, Queue, Fetcher } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";

export interface Env {
  // --- data ---
  DB_MOBILE: D1Database; // shared dub-core DB, mobile_* namespace only (theme12)
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)

  // --- service bindings (stubbed until 9-x結線) ---
  SVC_AUTH: Fetcher; // auth-service (/mobile/exchange, /auth/refresh, /auth/logout, /verify)
  SVC_IDENTITY: Fetcher; // identity-roster (/users/:id, /authz/check via auth-client)
  SVC_EVENT: Fetcher; // event-service (events/actions transparent + BFF)
  SVC_TASK: Fetcher; // task-service (tasks transparent + BFF)
  SVC_NOTIFICATION: Fetcher; // notification-service (inbox/preferences transparent + unread-count)

  // --- vars ---
  ENVIRONMENT?: string; // "local" | "preview" | "production" (default production)
  DEFAULT_ORG_ID?: string; // P0 single-org (common.DUB_DEFAULT_ORG_ID at Apply)

  // --- push provider secrets (interface-frozen; stubbed in P0) ---
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FCM_PROJECT_ID?: string;
}

export interface AppConfig {
  environment: string;
  isProduction: boolean;
  defaultOrgId: string;
  serviceName: string;
  pushConfigured: boolean; // false in P0 (secrets absent) -> adapters no-op
}

const DEFAULTS = {
  defaultOrgId: "org_devhub",
  serviceName: "mobile-bff",
} as const;

export function configFromEnv(env: Env): AppConfig {
  const environment = env.ENVIRONMENT ?? "production";
  return {
    environment,
    isProduction: environment === "production",
    defaultOrgId: env.DEFAULT_ORG_ID ?? DEFAULTS.defaultOrgId,
    serviceName: DEFAULTS.serviceName,
    pushConfigured: Boolean(env.APNS_KEY_P8 || env.FCM_SERVICE_ACCOUNT_JSON),
  };
}
