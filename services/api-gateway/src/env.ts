// Worker bindings (c.env). Service Bindings are Fetchers; EVT_NOTIFICATION is the
// single Queue producer (public.inquiry.received). Secrets/vars are plain strings.
import type { Fetcher, Queue, KVNamespace } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";

export interface GatewayEnv {
  // ---- Service Bindings (routing targets + BFF/me composition) ----
  SVC_AUTH: Fetcher;
  SVC_IDENTITY: Fetcher;
  SVC_EVENT: Fetcher;
  SVC_TASK: Fetcher;
  SVC_GANTT: Fetcher;
  SVC_NOTIFICATION: Fetcher;
  SVC_FILE_META: Fetcher;
  SVC_DRIVE_PROXY: Fetcher;
  // drive-share-service (Hackit Drive sharing manager). Optional so existing test
  // env builders (which don't set it) still satisfy the interface; the real gateway
  // binds it in wrangler. A missing binding → upstreamUnavailable on /driveshare only.
  SVC_DRIVE_SHARE?: Fetcher;
  SVC_CHAT: Fetcher;
  SVC_MAIL_GATEWAY: Fetcher;
  SVC_DEPLOY: Fetcher;
  SVC_GITHUB_SYNC: Fetcher;
  SVC_AUDIT_LOG: Fetcher;
  SVC_WEBHOOK_INGEST: Fetcher;
  SVC_USAGE_METER: Fetcher;

  // ---- Queue producer (the one publish exception) ----
  EVT_NOTIFICATION?: Queue<DubEventEnvelope>;

  // ---- Shared rate-limit state (optional; infra-provisioned) ----
  // When bound, the gateway uses a cross-isolate KV fixed-window limiter instead of
  // the per-isolate in-memory fallback — real limiting without a contract change (§7).
  RATE_LIMIT_KV?: KVNamespace;

  // ---- vars / secrets ----
  GATEWAY_VERSION?: string;
  ALLOWED_ORIGINS?: string;
  DEFAULT_MAX_BODY_BYTES?: string;
  FILES_MAX_BODY_BYTES?: string;
  TURNSTILE_SECRET?: string;
  // Rate-limit policy tuning (both optional; defaults 100 / 60_000 ms). Env-tunable
  // without a contract change — clients depend only on the wire signals (§7).
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}

/** Look up a Service Binding by its canonical name; undefined if not bound. */
export function bindingByName(env: GatewayEnv, name: string): Fetcher | undefined {
  return (env as unknown as Record<string, Fetcher | undefined>)[name];
}
