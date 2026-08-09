// Google OAuth access-token provider. Bot-user refresh_token grant (§3, §8-2 old#1);
// the refresh token lives only in Workers Secrets. Access token cached in KV
// (TTL = expiry - 60s). Workspace/SA migration is absorbed here later (contract
// unchanged). `fetchImpl` is injectable so tests never hit the network.
import { errors } from "@dub/errors";
import type { Cache } from "../cache";
import { TOKEN_KEY } from "../cache";

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TokenProvider {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

interface CachedToken {
  accessToken: string;
}
interface RefreshResponse {
  access_token?: string;
  expires_in?: number;
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function createTokenProvider(deps: {
  cache: Cache;
  credentials: GoogleCredentials;
  fetchImpl?: typeof fetch;
}): TokenProvider {
  const doFetch = deps.fetchImpl ?? fetch;

  async function refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: deps.credentials.clientId,
      client_secret: deps.credentials.clientSecret,
      refresh_token: deps.credentials.refreshToken,
    });
    let res: Response;
    try {
      res = await doFetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (cause) {
      // Never surface the credential/secret; log-worthy but generic to client.
      throw errors.upstreamUnavailable("google:auth", cause);
    }
    if (!res.ok) throw errors.upstreamUnavailable("google:auth");
    const json = (await res.json().catch(() => null)) as RefreshResponse | null;
    if (!json?.access_token) throw errors.upstreamUnavailable("google:auth");
    const ttl = typeof json.expires_in === "number" ? Math.max(1, json.expires_in - 60) : 3540;
    await deps.cache.set<CachedToken>(TOKEN_KEY, { accessToken: json.access_token }, ttl);
    return json.access_token;
  }

  return {
    async getAccessToken(opts): Promise<string> {
      if (!opts?.forceRefresh) {
        const hit = await deps.cache.get<CachedToken>(TOKEN_KEY);
        if (hit?.accessToken) return hit.accessToken;
      }
      return refresh();
    },
  };
}
