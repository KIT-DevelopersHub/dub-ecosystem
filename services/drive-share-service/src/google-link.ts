// 「Googleと連携」: a member proves which Google account is theirs so Meet attendance matches them
// automatically. Meet identifies a signed-in participant as users/{id}; that id is the Google
// account id, the same value as the OpenID `sub`. Dub's login does not keep the sub, so this is a
// minimal openid-only OAuth round-trip on the Web client the account connect already uses, sharing
// its return page (/driveshare) and state table — told apart by meeting.GOOGLE_LINK_STATE_PREFIX.
// Nothing but the sub is kept (no token).
import { errors } from "@dub/errors";
import { meeting } from "@dub/types";
import type { AttendanceStore } from "./attendance-store";
import { connectClient, type Env } from "./env";
import { isAllowedRedirectUri } from "./google-account";
import type { GoogleAccountStore } from "./google-account-store";
import { newOAuthState } from "./google/crypto";
import { TOKEN_ENDPOINT } from "./google/token";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE_TTL_MS = 10 * 60 * 1000;

export interface GoogleLinkService {
  start(userId: string, body: unknown): Promise<meeting.StartGoogleLinkResponse>;
  complete(userId: string, body: unknown): Promise<{ googleLinked: true }>;
}

/** The `sub` claim of an ID token received straight from Google's token endpoint (TLS, no relay —
 *  OIDC Core 3.1.3.7 lets the client skip signature checks in that case). */
export function subOfIdToken(idToken: string): string | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as { sub?: unknown };
    return typeof json.sub === "string" && /^[\w-]{1,64}$/.test(json.sub) ? json.sub : null;
  } catch {
    return null;
  }
}

export function createGoogleLinkService(deps: {
  env: Env;
  states: GoogleAccountStore;
  attendance: AttendanceStore;
  orgId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): GoogleLinkService {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const iso = (ms: number) => new Date(ms).toISOString();

  return {
    async start(userId, body) {
      const redirectUri = body && typeof body === "object" ? (body as { redirectUri?: unknown }).redirectUri : undefined;
      if (!isAllowedRedirectUri(redirectUri)) throw errors.validationFailed([{ field: "redirectUri", reason: "not_allowed" }]);
      const client = connectClient(deps.env);
      if (!client) throw errors.conflict("Google 連携の設定（Web 用 OAuth クライアント）がサーバーにありません。");
      const t = now();
      const state = `${meeting.GOOGLE_LINK_STATE_PREFIX}${newOAuthState()}`;
      await deps.states.purgeExpiredStates(iso(t));
      await deps.states.putState({ state, orgId: deps.orgId, userId, redirectUri, createdAt: iso(t), expiresAt: iso(t + STATE_TTL_MS) });
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid",
        prompt: "select_account",
        state,
      }).toString();
      return { authUrl: url.toString() };
    },

    async complete(userId, body) {
      const b = (body && typeof body === "object" ? body : {}) as Partial<meeting.CompleteGoogleLinkRequest>;
      if (typeof b.code !== "string" || !b.code || typeof b.state !== "string" || !b.state.startsWith(meeting.GOOGLE_LINK_STATE_PREFIX)) {
        throw errors.validationFailed([{ field: "code", reason: "required" }]);
      }
      const pending = await deps.states.consumeState(b.state);
      if (!pending || pending.orgId !== deps.orgId || pending.expiresAt < iso(now())) {
        throw errors.validationFailed([{ field: "state", reason: "invalid_or_expired" }], "連携の有効期限が切れました。もう一度「Googleと連携」からやり直してください。");
      }
      if (pending.userId !== userId) throw errors.forbidden("連携を始めたユーザーとは別のユーザーです。");
      const client = connectClient(deps.env);
      if (!client) throw errors.conflict("Google 連携の設定（Web 用 OAuth クライアント）がサーバーにありません。");
      let res: Response;
      try {
        res = await doFetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: b.code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: pending.redirectUri,
          }).toString(),
        });
      } catch (cause) {
        throw errors.upstreamUnavailable("google:auth", cause);
      }
      const json = (await res.json().catch(() => null)) as { id_token?: string; error?: string } | null;
      if (!res.ok || !json?.id_token) {
        if (json?.error === "invalid_grant") {
          throw errors.validationFailed([{ field: "code", reason: "invalid_grant" }], "Google の認可コードが無効か期限切れです。もう一度お試しください。");
        }
        throw errors.upstreamUnavailable("google:auth");
      }
      const sub = subOfIdToken(json.id_token);
      if (!sub) throw errors.upstreamUnavailable("google:auth");
      await deps.attendance.putLink({ orgId: deps.orgId, googleUserId: sub, userId, source: "self", linkedBy: userId, linkedAt: iso(now()) });
      return { googleLinked: true };
    },
  };
}
