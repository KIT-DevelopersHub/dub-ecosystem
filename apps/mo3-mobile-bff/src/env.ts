// Worker bindings + derived runtime config for MO3 mobile-bff.
// D1 (mobile_* namespace) + audit Queue + 5 Service Bindings. Push provider
// credentials are Workers Secrets (interface-frozen, stubbed in P0 — theme8/8-9).
import type { D1Database, Queue, Fetcher } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";

export interface Env {
  // --- data ---
  DB_MOBILE: D1Database; // shared dub-core DB, mobile_* namespace + freeq_outbox on free tier (theme12)

  // --- queue producer (PAID plan only) ---
  // Optional: on the Workers FREE plan this binding is absent and deps.ts falls back to
  // a @dub/freeq D1 outbox shim (see outbox.ts / drain.ts). When present (paid deploy,
  // wrangler.toml) the real Queue is used unchanged.
  AUDIT_QUEUE?: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)

  // --- service bindings (stubbed until 9-x結線) ---
  SVC_AUTH: Fetcher; // auth-service (/mobile/exchange, /auth/refresh, /auth/logout, /verify)
  SVC_IDENTITY: Fetcher; // identity-roster (/users/:id, /authz/check via auth-client)
  SVC_EVENT: Fetcher; // event-service (events/actions transparent + BFF)
  SVC_TASK: Fetcher; // task-service (tasks transparent + BFF)
  SVC_NOTIFICATION: Fetcher; // notification-service (inbox/preferences transparent + unread-count)
  SVC_AUDIT?: Fetcher; // audit-log (free-tier outbox drain -> POST /internal/audit-async); absent => drain defers

  // --- vars ---
  ENVIRONMENT?: string; // "local" | "preview" | "production" (default production)
  DEFAULT_ORG_ID?: string; // P0 single-org (common.DUB_DEFAULT_ORG_ID at Apply)

  // --- push provider secrets ---
  // APNs (iOS + macOS) share one p8 auth key (KeyId/TeamId); only the apns-topic
  // (= app bundle id) differs per platform. APNS_BUNDLE_ID is the iOS topic;
  // APNS_MACOS_BUNDLE_ID is the macOS app's bundle id (falls back to APNS_BUNDLE_ID
  // if the mac build shares the id).
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string; // iOS apns-topic
  APNS_MACOS_BUNDLE_ID?: string; // macOS apns-topic (defaults to APNS_BUNDLE_ID)
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FCM_PROJECT_ID?: string;
  // WNS (Windows) — Azure AD app registration for the client_credentials grant.
  WNS_PACKAGE_SID?: string; // ms-app://... -> OAuth client_id
  WNS_CLIENT_SECRET?: string; // Azure AD app client secret
  WNS_TENANT_ID?: string; // optional; defaults to the "common" endpoint
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
    pushConfigured: Boolean(
      env.APNS_KEY_P8 || env.FCM_SERVICE_ACCOUNT_JSON || env.WNS_PACKAGE_SID,
    ),
  };
}
