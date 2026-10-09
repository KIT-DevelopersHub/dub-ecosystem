// Which Google account drive-share-service acts as, and the admin flow that switches it.
//
// Precedence (resolveDriveCredentials): the account connected from ロール管理 (D1, sealed
// refresh token) → the GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN secret → none (mock Drive). So an
// environment that never connects anything keeps behaving exactly as before.
//
// Connect flow (authz: POLICY_TABLE, admin only):
//   1. POST /connect  — store a single-use state in D1, return Google's consent URL
//                       (access_type=offline + prompt=consent => a refresh token is always issued).
//   2. Google redirects the browser to the SPA's /admin/roles?code&state.
//   3. POST /callback — the SPA relays code+state; the state must exist, be unexpired and
//                       belong to the SAME admin; then code -> refresh token, seal, store.
// The refresh token never appears in a response or a log line.
import { errors } from "@dub/errors";
import { clientById, connectClient, type Env } from "./env";
import { newOAuthState, openToken, sealToken } from "./google/crypto";
import { createTokenProvider, isInvalidGrant, TOKEN_ENDPOINT, type GoogleCredentials } from "./google/token";
import type { GoogleAccountRow, GoogleAccountStore } from "./google-account-store";
import type { CompleteGoogleConnectRequest, GoogleAccountStatus, StartGoogleConnectResponse } from "./types";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const ABOUT_ENDPOINT = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const STATE_TTL_MS = 10 * 60 * 1000;
/** Google sends the admin back here; the SPA page that finishes the round-trip. */
export const OAUTH_RETURN_PATH = "/admin/roles";

export type ResolvedCredentials =
  | { source: "connected"; credentials: GoogleCredentials; row: GoogleAccountRow }
  | { source: "secret"; credentials: GoogleCredentials }
  | { source: "none" };

export async function resolveDriveCredentials(deps: {
  env: Env;
  store: GoogleAccountStore;
  orgId: string;
  key: CryptoKey | null;
}): Promise<ResolvedCredentials> {
  const { env } = deps;
  let row: GoogleAccountRow | null = null;
  try {
    row = await deps.store.get(deps.orgId);
  } catch {
    // e.g. driveshare/0002 not applied yet: keep serving Drive from the secret.
    console.warn(JSON.stringify({ service: "drive-share-service", event: "google_account_unreadable", orgId: deps.orgId }));
  }
  const client = row ? clientById(env, row.clientId) : null;
  if (row && client && deps.key) {
    try {
      const refreshToken = await openToken(deps.key, deps.orgId, { cipher: row.tokenCipher, iv: row.tokenIv });
      return { source: "connected", credentials: { ...client, refreshToken }, row };
    } catch {
      // Wrong/rotated key or tampered row: unusable. Fall through to the secret so Drive
      // keeps working; the status shows source=secret and the admin can reconnect.
      console.warn(JSON.stringify({ service: "drive-share-service", event: "google_account_unsealable", orgId: deps.orgId }));
    }
  }
  if (env.GOOGLE_HACKIT_OAUTH_CLIENT_ID && env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET && env.GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN) {
    return {
      source: "secret",
      credentials: {
        clientId: env.GOOGLE_HACKIT_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET,
        refreshToken: env.GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN,
      },
    };
  }
  return { source: "none" };
}

/** Only https origins (or local dev) and only the one SPA page may receive the code. */
export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !local) return false;
  return u.pathname === OAUTH_RETURN_PATH && u.search === "" && u.hash === "" && u.username === "" && u.password === "";
}

export interface GoogleAccountService {
  status(): Promise<GoogleAccountStatus>;
  startConnect(userId: string, redirectUri: unknown): Promise<StartGoogleConnectResponse>;
  completeConnect(userId: string, body: Partial<CompleteGoogleConnectRequest>): Promise<GoogleAccountStatus>;
}

export function createGoogleAccountService(deps: {
  env: Env;
  store: GoogleAccountStore;
  orgId: string;
  /** DRIVESHARE_TOKEN_ENC_KEY, imported (null = connect flow disabled). */
  key: CryptoKey | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): GoogleAccountService {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const iso = (ms: number) => new Date(ms).toISOString();
  const canConnect = connectClient(deps.env) !== null && deps.key !== null;

  async function accountEmail(accessToken: string): Promise<string | null> {
    try {
      const res = await doFetch(ABOUT_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { user?: { emailAddress?: string } } | null;
      return json?.user?.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  return {
    async status() {
      const resolved = await resolveDriveCredentials({ env: deps.env, store: deps.store, orgId: deps.orgId, key: deps.key });
      const base: GoogleAccountStatus = {
        source: resolved.source,
        email: resolved.source === "connected" ? resolved.row.email : null,
        connectedAt: resolved.source === "connected" ? resolved.row.connectedAt : null,
        connectedBy: resolved.source === "connected" ? resolved.row.connectedBy : null,
        needsReconnect: false,
        canConnect,
      };
      if (resolved.source === "none") return base;
      // Probe the token so a revoked / expired grant shows up before anyone hits Drive.
      try {
        const accessToken = await createTokenProvider({ credentials: resolved.credentials, fetchImpl: doFetch, now }).getAccessToken();
        if (resolved.source === "secret") base.email = await accountEmail(accessToken);
      } catch (err) {
        if (isInvalidGrant(err)) base.needsReconnect = true;
      }
      return base;
    },

    async startConnect(userId, redirectUri) {
      if (!isAllowedRedirectUri(redirectUri)) {
        throw errors.validationFailed([{ field: "redirectUri", reason: "not_allowed" }]);
      }
      const client = connectClient(deps.env);
      if (!client || !deps.key) {
        throw errors.conflict("Google アカウント接続の設定（OAuth クライアント / 暗号化キー）がサーバーにありません。");
      }
      const t = now();
      await deps.store.purgeExpiredStates(iso(t));
      const state = newOAuthState();
      await deps.store.putState({
        state,
        orgId: deps.orgId,
        userId,
        redirectUri,
        createdAt: iso(t),
        expiresAt: iso(t + STATE_TTL_MS),
      });
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: DRIVE_SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      return { authUrl: url.toString() };
    },

    async completeConnect(userId, body) {
      if (typeof body.code !== "string" || !body.code || typeof body.state !== "string" || !body.state) {
        throw errors.validationFailed([{ field: "code", reason: "required" }]);
      }
      const pending = await deps.store.consumeState(body.state);
      const t = now();
      if (!pending || pending.orgId !== deps.orgId || pending.expiresAt < iso(t)) {
        throw errors.validationFailed(
          [{ field: "state", reason: "invalid_or_expired" }],
          "接続の有効期限が切れたか、無効なリクエストです。もう一度「接続」からやり直してください。",
        );
      }
      // The admin who finishes must be the admin who started (state is bound to them).
      if (pending.userId !== userId) throw errors.forbidden("接続を開始した管理者とは別のユーザーです。");

      const client = connectClient(deps.env);
      const sealKey = deps.key;
      if (!client || !sealKey) {
        throw errors.conflict("Google アカウント接続の設定（OAuth クライアント / 暗号化キー）がサーバーにありません。");
      }

      let res: Response;
      try {
        res = await doFetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: body.code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: pending.redirectUri,
          }).toString(),
        });
      } catch (cause) {
        throw errors.upstreamUnavailable("google:auth", cause);
      }
      const json = (await res.json().catch(() => null)) as
        | { access_token?: string; refresh_token?: string; error?: string }
        | null;
      if (!res.ok) {
        if (json?.error === "invalid_grant") {
          throw errors.validationFailed(
            [{ field: "code", reason: "invalid_grant" }],
            "Google の認可コードが無効か期限切れです。もう一度「接続」からやり直してください。",
          );
        }
        throw errors.upstreamUnavailable("google:auth");
      }
      if (!json?.access_token || !json.refresh_token) {
        throw errors.validationFailed(
          [{ field: "code", reason: "no_refresh_token" }],
          "Google から更新用トークンが返りませんでした。もう一度「接続」からやり直してください。",
        );
      }
      const email = await accountEmail(json.access_token);
      if (!email) throw errors.upstreamUnavailable("google:drive");

      const sealed = await sealToken(sealKey, deps.orgId, json.refresh_token);
      const at = iso(t);
      await deps.store.put({
        orgId: deps.orgId,
        email,
        clientId: client.clientId,
        tokenCipher: sealed.cipher,
        tokenIv: sealed.iv,
        connectedBy: userId,
        connectedAt: at,
        updatedAt: at,
      });
      return { source: "connected", email, connectedAt: at, connectedBy: userId, needsReconnect: false, canConnect: true };
    },
  };
}
