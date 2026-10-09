// Worker entrypoint / composition root. buildApp wires the REAL bindings -> deps ->
// Hono app: the real Google Drive/Sheets client, the real OAuth refresh-token
// provider (refresh token from Workers Secrets, access token KV-cached), the real KV
// response cache + soft rate-limiter, the real file-meta + audit queue publishers, and
// the real @dub/policy-gate granter over identity /authz/check (authz itself is
// POLICY_TABLE in src/policy-table.ts). There is NO stub/mock wiring here — the
// injectable fetch/deps seams in the google/* and events modules exist only so unit
// tests avoid the network. What remains before this Worker can deploy is apply-time
// provisioning ONLY (the KV namespace id + the `DB` D1 id in wrangler.toml, the three
// GOOGLE_OAUTH_* secrets and, for Drive-watch, DRIVE_WEBHOOK_TOKEN + the callback URL),
// not code wiring. Drive change-notification (files.watch) IS now结线: when a `DB` D1
// and the watch secrets are bound, POST /drive/watch registers a channel and mints the
// X-Goog-Channel-Token that webhook-ingest verifies; the channel lifecycle is persisted
// in the `drive_watch_channels` registry (this D1 is watch state ONLY — file metadata
// stays with file-meta-service). When no D1 is bound the watch routes 500 and the rest
// of the surface is unaffected.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { newRequestId } from "@dub/http";
import { sharedAuthzGranter } from "@dub/policy-gate";
import { createApp } from "./app";
import { createKvCache } from "./cache";
import { createKvRateLimiter } from "./ratelimit";
import { createEventPublisher } from "./events";
import { buildPublisherEnv } from "./outbox";
import { createGoogleClient } from "./google/client";
import { createTokenProvider } from "./google/token";
import { createDriveService } from "./service";
import { createWatchChannelRepo } from "./watch/repo";
import { createWatchService, type WatchService } from "./watch/service";
import { parseConfig, type Env } from "./env";

function buildApp(env: Env, requestId: string): ReturnType<typeof createApp> {
  const cache = createKvCache(env.KV);
  const config = parseConfig(env);
  const token = createTokenProvider({
    cache,
    credentials: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    },
  });
  const google = createGoogleClient({ token });
  const rate = createKvRateLimiter(env.KV, { windowSeconds: config.rateWindowSeconds, softLimit: config.rateSoftLimit });
  // buildPublisherEnv resolves each producer: the real (paid) Queue binding when present,
  // otherwise the free-tier @dub/freeq D1 outbox shim (OUTBOX_DB). createEventPublisher
  // sees the same {EVT_FILE_META, AUDIT_QUEUE} shape either way — the swap is invisible.
  const events = createEventPublisher(buildPublisherEnv(env));
  const service = createDriveService({ google, cache, rate, events, config });
  // sharedAuthzGranter (not createAuthzGranter): the app is rebuilt per request, so the
  // identity /authz/check TTL cache has to be memoized per Env to survive between requests
  // in the same isolate — otherwise every gated route is an unconditional identity
  // subrequest and identity-roster becomes a hot-path single point of failure (ADR 0004).
  const authz = sharedAuthzGranter(env, env.SVC_IDENTITY, { caller: "drive-proxy", requestId });
  const watch = buildWatch(env, google, rate, events, config);
  return createApp({ service, authz, ...(watch ? { watch } : {}) });
}

/**
 * Build the Drive-watch service iff its prerequisites are bound: the `DB` D1 (watch
 * registry) and the current channel token secret. Absent either, watch routes 500 but
 * the read/write/sheets surface is unaffected — this keeps P0 (no-D1) deploys building.
 */
function buildWatch(
  env: Env,
  google: ReturnType<typeof createGoogleClient>,
  rate: ReturnType<typeof createKvRateLimiter>,
  events: ReturnType<typeof createEventPublisher>,
  config: ReturnType<typeof parseConfig>,
): WatchService | null {
  if (!env.DB || !env.DRIVE_WEBHOOK_TOKEN || !env.DRIVE_WATCH_CALLBACK_URL) return null;
  const repo = createWatchChannelRepo(env.DB);
  return createWatchService({
    google,
    repo,
    rate,
    events,
    config: { callbackUrl: env.DRIVE_WATCH_CALLBACK_URL, ttlSeconds: config.watchTtlSeconds },
    tokens: { current: env.DRIVE_WEBHOOK_TOKEN, ...(env.DRIVE_WEBHOOK_TOKEN_NEXT ? { next: env.DRIVE_WEBHOOK_TOKEN_NEXT } : {}) },
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? newRequestId();
    return buildApp(env, requestId).fetch(request, env, ctx);
  },

  // NOTE: no scheduled() drain here. The freeq outbox is drained centrally by the
  // standalone freeq-drain worker (single aggregated cron). src/drain.ts is retained as
  // the topic->destination contract source (audit.record) for freeq-drain's routing.
};
