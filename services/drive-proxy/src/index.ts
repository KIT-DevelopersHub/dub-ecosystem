// Worker entrypoint / composition root. buildApp wires the REAL bindings -> deps ->
// Hono app: the real Google Drive/Sheets client, the real OAuth refresh-token
// provider (refresh token from Workers Secrets, access token KV-cached), the real KV
// response cache + soft rate-limiter, the real file-meta + audit queue publishers, and
// the real identity /authz/check checker. There is NO stub/mock wiring here — the
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
import type { ExecutionContext, Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, newRequestId } from "@dub/http";
import type { identity } from "@dub/types";
import { createApp } from "./app";
import { createKvCache } from "./cache";
import { createKvRateLimiter } from "./ratelimit";
import { createEventPublisher } from "./events";
import { createGoogleClient } from "./google/client";
import { createTokenProvider } from "./google/token";
import { createDriveService } from "./service";
import { createWatchChannelRepo } from "./watch/repo";
import { createWatchService, type WatchService } from "./watch/service";
import type { PermissionChecker, DrivePermission } from "./permissions";
import { parseConfig, type Env } from "./env";

/**
 * identity /authz/check checker. drive:read / drive:write are not yet in the frozen
 * PermissionKey union (§8-1#2) so the key is cast at the wire boundary; identity
 * resolves it as a plain string. Swap the cast for a typed key when the catalog
 * adds the two entries (no behavioural change).
 */
function createIdentityAuthz(binding: Fetcher): PermissionChecker {
  const client = createServiceClient(binding, { service: "identity-roster", caller: "drive-proxy" });
  return {
    async check(userId: string, orgId: string, permission: DrivePermission): Promise<boolean> {
      const req: identity.AuthzCheckRequest = {
        subjectUserId: userId,
        orgId,
        checks: [{ permission: permission as unknown as identity.PermissionKey }],
      };
      const res = await client.post<identity.AuthzCheckResponse>({ requestId: newRequestId() }, "/authz/check", req);
      return res.decisions[0]?.allowed ?? false;
    },
  };
}

function buildApp(env: Env): ReturnType<typeof createApp> {
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
  const events = createEventPublisher(env);
  const service = createDriveService({ google, cache, rate, events, config });
  const authz = createIdentityAuthz(env.SVC_IDENTITY);
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
    return buildApp(env).fetch(request, env, ctx);
  },
};
