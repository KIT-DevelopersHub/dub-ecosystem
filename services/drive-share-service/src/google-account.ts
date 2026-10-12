// Which Google account drive-share-service acts as, and the admin flow that registers and
// switches between accounts.
//
// Precedence (resolveDriveCredentials): the account selected in ロール管理 (D1, sealed refresh
// token) → the GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN secret → none (mock Drive). So an environment
// that never registers anything keeps behaving exactly as before.
//
// Add-account flow (authz: POLICY_TABLE, admin only):
//   1. POST /connect  — store a single-use state in D1, return Google's consent URL
//                       (access_type=offline + prompt=consent => a refresh token is always issued).
//   2. Google redirects the browser to the SPA's /admin/roles?code&state.
//   3. POST /callback — the SPA relays code+state; the state must exist, be unexpired and
//                       belong to the SAME admin; then code -> refresh token, seal, register
//                       (the same address replaces its token) and switch to it.
// POST /active switches between registered accounts (or back to the secret); DELETE removes
// one that is not in use. The refresh token never appears in a response or a log line.
import { CommonErrorCodes, DubError, errors } from "@dub/errors";
import { newId } from "@dub/db";
import { clientById, connectClient, type Env } from "./env";
import { newOAuthState, openToken, sealToken } from "./google/crypto";
import { createTokenProvider, isInvalidGrant, TOKEN_ENDPOINT, type GoogleCredentials } from "./google/token";
import type { GoogleAccountRow, GoogleAccountStore } from "./google-account-store";
import {
  SECRET_ACCOUNT_ID,
  type CompleteGoogleConnectRequest,
  type GoogleAccountEntry,
  type GoogleAccountsStatus,
  type StartGoogleConnectResponse,
} from "./types";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const ABOUT_ENDPOINT = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const STATE_TTL_MS = 10 * 60 * 1000;
/** Google sends the admin back here; the SPA page that finishes the round-trip. */
export const OAUTH_RETURN_PATH = "/admin/roles";

export type ResolvedCredentials =
  | { source: "connected"; credentials: GoogleCredentials; row: GoogleAccountRow }
  /** The selected account cannot be used (key/client secret gone, or the seal does not
   *  open). Drive fails closed instead of silently acting as the secret's account. */
  | { source: "unusable"; row: GoogleAccountRow }
  | { source: "secret"; credentials: GoogleCredentials }
  | { source: "none" };

/** driveshare/0002 not applied yet (D1 "no such table"), anywhere in the cause chain. */
export function isMissingTable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof Error && /no such table/i.test(e.message)) return true;
  }
  return false;
}

/** Drive call while the selected account is unusable: ask an admin to reconnect it. */
export function reconnectRequired(): DubError {
  return new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "Google アカウントの再接続が必要です（ロール管理 > その他 > Google アカウント）。", {
    details: { reason: "reconnect_required" },
    retryable: false,
    service: "google:auth",
  });
}

/** The AES-GCM additional data: a sealed token only opens on its own account row. */
function sealBinding(orgId: string, email: string): string {
  return `${orgId}/${email}`;
}

function secretCredentials(env: Env): GoogleCredentials | null {
  if (env.GOOGLE_HACKIT_OAUTH_CLIENT_ID && env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET && env.GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN) {
    return {
      clientId: env.GOOGLE_HACKIT_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_HACKIT_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_HACKIT_OAUTH_REFRESH_TOKEN,
    };
  }
  return null;
}

/** Open a registered account's token. null = unusable (client gone / key gone / bad seal). */
async function credentialsFor(env: Env, key: CryptoKey | null, row: GoogleAccountRow): Promise<GoogleCredentials | null> {
  const client = clientById(env, row.clientId);
  if (!client || !key) return null;
  try {
    const refreshToken = await openToken(key, sealBinding(row.orgId, row.email), { cipher: row.tokenCipher, iv: row.tokenIv });
    return { ...client, refreshToken };
  } catch {
    // Wrong/rotated key or tampered row.
    console.warn(JSON.stringify({ service: "drive-share-service", event: "google_account_unsealable", orgId: row.orgId, accountId: row.id }));
    return null;
  }
}

/** Reads that treat "migration not applied yet" as "nothing registered". Any other D1 failure
 *  propagates, so Drive is never quietly switched to the secret's account for a request. */
async function orEmpty<T>(read: () => Promise<T>, empty: T, orgId: string): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn(JSON.stringify({ service: "drive-share-service", event: "google_account_table_missing", orgId }));
    return empty;
  }
}

export async function resolveDriveCredentials(deps: {
  env: Env;
  store: GoogleAccountStore;
  orgId: string;
  key: CryptoKey | null;
}): Promise<ResolvedCredentials> {
  const row = await orEmpty(() => deps.store.getActive(deps.orgId), null, deps.orgId);
  if (row) {
    const credentials = await credentialsFor(deps.env, deps.key, row);
    return credentials ? { source: "connected", credentials, row } : { source: "unusable", row };
  }
  const secret = secretCredentials(deps.env);
  return secret ? { source: "secret", credentials: secret } : { source: "none" };
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
  status(): Promise<GoogleAccountsStatus>;
  startConnect(userId: string, redirectUri: unknown): Promise<StartGoogleConnectResponse>;
  /** Register the account Google returned (or refresh its token) and switch to it. */
  completeConnect(userId: string, body: Partial<CompleteGoogleConnectRequest>): Promise<GoogleAccountsStatus>;
  switchTo(userId: string, accountId: unknown): Promise<GoogleAccountsStatus>;
  remove(accountId: string): Promise<GoogleAccountsStatus>;
}

export function createGoogleAccountService(deps: {
  env: Env;
  store: GoogleAccountStore;
  orgId: string;
  /** DRIVESHARE_TOKEN_ENC_KEY, imported (null = adding accounts disabled). */
  key: CryptoKey | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  newId?: () => string;
}): GoogleAccountService {
  const { env, store, orgId } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const makeId = deps.newId ?? (() => newId("dga"));
  const iso = (ms: number) => new Date(ms).toISOString();
  const canConnect = connectClient(env) !== null && deps.key !== null;

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

  /** Try the token so a revoked / expired grant shows before anyone hits Drive.
   *  invalid_grant => reconnect; other failures (network) are not the account's fault. */
  async function probe(credentials: GoogleCredentials): Promise<{ accessToken: string | null; invalid: boolean }> {
    try {
      return { accessToken: await createTokenProvider({ credentials, fetchImpl: doFetch, now }).getAccessToken(), invalid: false };
    } catch (err) {
      return { accessToken: null, invalid: isInvalidGrant(err) };
    }
  }

  async function status(): Promise<GoogleAccountsStatus> {
    const [rows, activeRow] = await Promise.all([
      orEmpty(() => store.list(orgId), [] as GoogleAccountRow[], orgId),
      orEmpty(() => store.getActive(orgId), null, orgId),
    ]);
    const entries: Promise<GoogleAccountEntry>[] = rows.map(async (row): Promise<GoogleAccountEntry> => {
      const credentials = await credentialsFor(env, deps.key, row);
      const needsReconnect = credentials ? (await probe(credentials)).invalid : true;
      return {
        id: row.id,
        kind: "connected",
        email: row.email,
        connectedAt: row.connectedAt,
        connectedBy: row.connectedBy,
        active: row.id === activeRow?.id,
        needsReconnect,
      };
    });
    const secret = secretCredentials(env);
    if (secret) {
      entries.unshift(
        probe(secret).then(async ({ accessToken, invalid }): Promise<GoogleAccountEntry> => ({
          id: SECRET_ACCOUNT_ID,
          kind: "secret",
          email: accessToken ? await accountEmail(accessToken) : null,
          connectedAt: null,
          connectedBy: null,
          active: !activeRow,
          needsReconnect: invalid,
        })),
      );
    }
    return { accounts: await Promise.all(entries), canConnect };
  }

  return {
    status,

    async startConnect(userId, redirectUri) {
      if (!isAllowedRedirectUri(redirectUri)) {
        throw errors.validationFailed([{ field: "redirectUri", reason: "not_allowed" }]);
      }
      const client = connectClient(env);
      if (!client || !deps.key) {
        throw errors.conflict("Google アカウント追加の設定（Web 用 OAuth クライアント / 暗号化キー）がサーバーにありません。");
      }
      const t = now();
      const state = newOAuthState();
      try {
        await store.purgeExpiredStates(iso(t));
        await store.putState({ state, orgId, userId, redirectUri, createdAt: iso(t), expiresAt: iso(t + STATE_TTL_MS) });
      } catch (err) {
        if (isMissingTable(err)) {
          throw errors.conflict("接続に使う DB の設定（マイグレーション driveshare/0002）がまだ適用されていません。");
        }
        throw err;
      }
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
      const pending = await store.consumeState(body.state);
      const t = now();
      if (!pending || pending.orgId !== orgId || pending.expiresAt < iso(t)) {
        throw errors.validationFailed(
          [{ field: "state", reason: "invalid_or_expired" }],
          "接続の有効期限が切れたか、無効なリクエストです。もう一度「アカウントを追加」からやり直してください。",
        );
      }
      // The admin who finishes must be the admin who started (state is bound to them).
      if (pending.userId !== userId) throw errors.forbidden("接続を開始した管理者とは別のユーザーです。");

      const client = connectClient(env);
      const sealKey = deps.key;
      if (!client || !sealKey) {
        throw errors.conflict("Google アカウント追加の設定（Web 用 OAuth クライアント / 暗号化キー）がサーバーにありません。");
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
            "Google の認可コードが無効か期限切れです。もう一度「アカウントを追加」からやり直してください。",
          );
        }
        throw errors.upstreamUnavailable("google:auth");
      }
      if (!json?.access_token || !json.refresh_token) {
        throw errors.validationFailed(
          [{ field: "code", reason: "no_refresh_token" }],
          "Google から更新用トークンが返りませんでした。もう一度「アカウントを追加」からやり直してください。",
        );
      }
      const email = await accountEmail(json.access_token);
      if (!email) throw errors.upstreamUnavailable("google:drive");

      const sealed = await sealToken(sealKey, sealBinding(orgId, email), json.refresh_token);
      const at = iso(t);
      const id = await store.upsert({
        id: makeId(),
        orgId,
        email,
        clientId: client.clientId,
        tokenCipher: sealed.cipher,
        tokenIv: sealed.iv,
        connectedBy: userId,
        connectedAt: at,
        updatedAt: at,
      });
      await store.setActive(orgId, id, userId, at);
      return status();
    },

    async switchTo(userId, accountId) {
      if (typeof accountId !== "string" || !accountId) {
        throw errors.validationFailed([{ field: "accountId", reason: "required" }]);
      }
      if (accountId === SECRET_ACCOUNT_ID) {
        if (!secretCredentials(env)) throw errors.notFound("google-account", accountId);
        await orEmpty(() => store.clearActive(orgId), undefined, orgId);
        return status();
      }
      const switched = await orEmpty(() => store.setActive(orgId, accountId, userId, iso(now())), false, orgId);
      if (!switched) throw errors.notFound("google-account", accountId);
      return status();
    },

    async remove(accountId) {
      const rows = await orEmpty(() => store.list(orgId), [] as GoogleAccountRow[], orgId);
      if (!rows.some((r) => r.id === accountId)) throw errors.notFound("google-account", accountId);
      if (!(await store.remove(orgId, accountId))) {
        throw errors.conflict("使用中のアカウントは削除できません。先に別のアカウントに切り替えてください。");
      }
      return status();
    },
  };
}
