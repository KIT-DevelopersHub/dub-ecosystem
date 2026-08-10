// Google OAuth 2.0 provider — MOBILE ONLY. Web Google login was removed; the only
// remaining Google path is the mobile exchange (MO3 forwards an already-PKCE'd
// code). The interface is the seam the app depends on; the Google HTTP impl is
// swapped for a fake in tests. id_token JWKS verification is deferred (P0): the
// userinfo endpoint is used to resolve the profile — see notes.
import type { AppConfig } from "./env";
import { authErrors } from "./errors";

export interface GoogleProfile {
  sub: string; // Google account id (stable)
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface OAuthProvider {
  // Mobile flow: MO3 forwards an already-PKCE'd code; single-token model (theme8).
  exchangeMobileCode(code: string): Promise<GoogleProfile>;
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
}
interface UserInfoResponse {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
}

export class GoogleOAuthProvider implements OAuthProvider {
  constructor(private readonly config: AppConfig) {}

  async exchangeMobileCode(code: string): Promise<GoogleProfile> {
    // Mobile clients are public (PKCE, no secret). client_id selection per platform
    // is applied by MO3 before forwarding; P0 uses the configured mobile client ids.
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.config.google.iosClientId || this.config.google.androidClientId,
    });
    return this.exchange(body);
  }

  private async exchange(body: URLSearchParams): Promise<GoogleProfile> {
    let tokenRes: Response;
    try {
      tokenRes = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (cause) {
      throw authErrors.oauthExchangeFailed(cause);
    }
    if (!tokenRes.ok) throw authErrors.oauthExchangeFailed(`token endpoint ${tokenRes.status}`);
    const token = (await tokenRes.json()) as TokenResponse;
    if (token.error || !token.access_token) throw authErrors.oauthExchangeFailed(token.error ?? "no access_token");

    let infoRes: Response;
    try {
      infoRes = await fetch(USERINFO_ENDPOINT, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
    } catch (cause) {
      throw authErrors.oauthExchangeFailed(cause);
    }
    if (!infoRes.ok) throw authErrors.oauthExchangeFailed(`userinfo ${infoRes.status}`);
    const info = (await infoRes.json()) as UserInfoResponse;
    if (!info.sub || !info.email) throw authErrors.oauthExchangeFailed("userinfo missing sub/email");
    return {
      sub: info.sub,
      email: info.email,
      displayName: info.name ?? info.email,
      avatarUrl: info.picture ?? null,
    };
  }
}
