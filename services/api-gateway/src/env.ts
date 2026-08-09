// Worker bindings (c.env). Service Bindings are Fetchers; EVT_NOTIFICATION is the
// single Queue producer (public.inquiry.received). Secrets/vars are plain strings.
import type { Fetcher, Queue } from "@cloudflare/workers-types";
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
  SVC_CHAT: Fetcher;
  SVC_DEPLOY: Fetcher;
  SVC_GITHUB_SYNC: Fetcher;
  SVC_AUDIT_LOG: Fetcher;
  SVC_WEBHOOK_INGEST: Fetcher;

  // ---- Queue producer (the one publish exception) ----
  EVT_NOTIFICATION?: Queue<DubEventEnvelope>;

  // ---- vars / secrets ----
  GATEWAY_VERSION?: string;
  ALLOWED_ORIGINS?: string;
  DEFAULT_MAX_BODY_BYTES?: string;
  FILES_MAX_BODY_BYTES?: string;
  TURNSTILE_SECRET?: string;
}

/** Look up a Service Binding by its canonical name; undefined if not bound. */
export function bindingByName(env: GatewayEnv, name: string): Fetcher | undefined {
  return (env as unknown as Record<string, Fetcher | undefined>)[name];
}
