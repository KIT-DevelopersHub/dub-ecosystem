// Google OAuth access-token provider for the Hackit shared Gmail. Personal-account
// refresh_token grant (§ personal Gmail cannot use SA/DWD); the refresh token lives
// only in Workers Secrets. Access token is cached IN-ISOLATE (no KV needed → $0) with
// TTL = expiry - 60s. The credential/secret is never surfaced in an error. `fetchImpl`
// is injectable so tests never hit the network.
import { errors } from "@dub/errors";

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TokenProvider {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

interface RefreshResponse {
  access_token?: string;
  expires_in?: number;
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** In-isolate cached token. A Workers isolate is short-lived; a cold start just
 *  refreshes once. This keeps the service dependency-free (no KV) and $0. */
interface Cached {
  accessToken: string;
  expiresAtMs: number;
}

export function createTokenProvider(deps: {
  credentials: GoogleCredentials;
  fetchImpl?: typeof fetch;
  /** injectable clock for tests */
  now?: () => number;
}): TokenProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  let cache: Cached | null = null;

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
    const ttlSec = typeof json.expires_in === "number" ? Math.max(1, json.expires_in - 60) : 3540;
    cache = { accessToken: json.access_token, expiresAtMs: now() + ttlSec * 1000 };
    return json.access_token;
  }

  return {
    async getAccessToken(opts): Promise<string> {
      if (!opts?.forceRefresh && cache && cache.expiresAtMs > now()) return cache.accessToken;
      return refresh();
    },
  };
}
