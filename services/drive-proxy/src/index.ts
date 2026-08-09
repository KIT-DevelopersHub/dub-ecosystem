// Worker entrypoint. Wires real bindings -> deps -> Hono app. NOT deployed in P0
// (mock/stub波; real Google结线 waits on the integration wave). No D1 binding.
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
  return createApp({ service, authz });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return buildApp(env).fetch(request, env, ctx);
  },
};
