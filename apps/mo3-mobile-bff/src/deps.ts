// Dependency seam: the Hono app is built from this bag so tests inject fakes
// (stores, service clients, authenticator, audit) without any Cloudflare runtime.
import type { auditLog, mobile } from "@dub/types";
import { createServiceClient, newRequestId, type ServiceClient } from "@dub/http";
import { createDbClient } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { publishAudit } from "@dub/events";
import { configFromEnv, type AppConfig, type Env } from "./env";
import { type Authenticator, DubAuthenticator } from "./authn";
import { D1DeviceStore, type DeviceStore } from "./devices";
import { D1DeliveryStore, type DeliveryStore } from "./deliveries";
import { ApnsAdapter, FcmAdapter, type PushAdapter, type PushRetryPolicy } from "./push";
import type { ApnsCredentials } from "./apns";
import type { FcmServiceAccount } from "./fcm";
import { D1ChangeLogReader, D1ChangeLogStore, type ChangeLogReader, type ChangeLogStore } from "./change-log";
import { D1MutationStore, type MutationStore } from "./mutation-store";
import { AUDIT_TOPIC, outboxQueue } from "./outbox";

export interface Deps {
  config: AppConfig;
  authenticator: Authenticator; // verify (mode:"verify") + capability resolution
  auth: ServiceClient; // auth-service (exchange/refresh/logout delegation)
  identity: ServiceClient; // identity-roster (/me)
  event: ServiceClient; // event-service (transparent + BFF)
  task: ServiceClient; // task-service (transparent + BFF)
  notification: ServiceClient; // notification-service (transparent + unread)
  devices: DeviceStore;
  deliveries: DeliveryStore;
  changeLog: ChangeLogReader; // differential delete feed for /sync
  changeLogStore: ChangeLogStore; // append feed writer for the /internal/events-async landing route
  mutations: MutationStore; // durable idempotency for offline replay
  pushAdapters: Record<mobile.MobilePlatform, PushAdapter>;
  pushRetry: PushRetryPolicy; // bounded retry/backoff for hard send failures
  audit: (input: auditLog.AuditRecordInput) => Promise<void>;
  newRequestId: () => string;
}

/** Wire the production dependencies from Worker bindings. */
export function buildDeps(env: Env): Deps {
  const config = configFromEnv(env);
  const caller = config.serviceName;
  const db = createDbClient(env.DB_MOBILE, { namespace: "mobile" });

  const authClient = createAuthClient({
    identityBinding: env.SVC_IDENTITY,
    authBinding: env.SVC_AUTH,
    serviceName: caller,
    mode: "verify", // MO3 is an entrypoint: verify once, propagate trusted headers
  });

  return {
    config,
    authenticator: new DubAuthenticator(authClient),
    auth: createServiceClient(env.SVC_AUTH, { service: "auth-service", caller }),
    identity: createServiceClient(env.SVC_IDENTITY, { service: "identity-roster", caller }),
    event: createServiceClient(env.SVC_EVENT, { service: "event-service", caller }),
    task: createServiceClient(env.SVC_TASK, { service: "task-service", caller }),
    notification: createServiceClient(env.SVC_NOTIFICATION, { service: "notification-service", caller }),
    devices: new D1DeviceStore(db),
    deliveries: new D1DeliveryStore(db),
    changeLog: new D1ChangeLogReader(db),
    changeLogStore: new D1ChangeLogStore(db),
    mutations: new D1MutationStore(db),
    pushAdapters: buildPushAdapters(env),
    pushRetry: { maxAttempts: 3 },
    // Prefer the real (paid) Queue binding; else fall back to the free-tier @dub/freeq D1
    // outbox shim so push delivery-failure audit records are durably persisted, never
    // dropped. The drain (drain.ts) forwards them to audit-log on the Cron tick.
    audit: (input) => publishAudit({ AUDIT_QUEUE: env.AUDIT_QUEUE ?? outboxQueue(env.DB_MOBILE, AUDIT_TOPIC) }, input),
    newRequestId,
  };
}

/**
 * Construct the per-platform push adapters from Worker Secrets. Previously the
 * adapters were built with a bare boolean (`config.pushConfigured`), which per
 * push.ts carries NO credentials — so send() always returned "failed" even when the
 * secrets were set, and no push ever went out. Here we parse the real credentials and
 * hand them to the adapters. A missing/malformed secret degrades to a credential-less
 * adapter (send() -> "failed", audited upstream) instead of throwing at worker boot.
 */
export function buildPushAdapters(env: Env): Record<mobile.MobilePlatform, PushAdapter> {
  const apns = apnsCredentials(env);
  return {
    // ApnsAdapterOptions nests the credentials under `credentials` — passing the bare
    // ApnsCredentials object would leave opts.credentials undefined (send() -> "failed").
    ios: new ApnsAdapter(apns ? { credentials: apns } : false),
    android: new FcmAdapter(fcmOptions(env)),
  };
}

/** APNs p8 credentials from secrets; null unless the full set is present. */
export function apnsCredentials(env: Env): ApnsCredentials | null {
  const { APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = env;
  if (!APNS_KEY_P8 || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) return null;
  return { keyP8: APNS_KEY_P8, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, bundleId: APNS_BUNDLE_ID };
}

/** FCM (Android, $0) HTTP v1 options from the service-account JSON secret. A parse
 *  failure yields a credential-less adapter rather than crashing the worker. */
export function fcmOptions(env: Env): { serviceAccount: FcmServiceAccount | null; projectId?: string } {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return { serviceAccount: null };
  let serviceAccount: FcmServiceAccount | null = null;
  try {
    const parsed = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as FcmServiceAccount;
    if (parsed && typeof parsed.client_email === "string" && typeof parsed.private_key === "string") {
      serviceAccount = parsed;
    }
  } catch {
    serviceAccount = null; // malformed secret -> send() returns "failed" (audited)
  }
  return { serviceAccount, ...(env.FCM_PROJECT_ID ? { projectId: env.FCM_PROJECT_ID } : {}) };
}
