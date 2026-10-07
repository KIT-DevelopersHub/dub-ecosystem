// FE2 api-client — the single gateway call surface for FE3-FE7 (design 2-4).
// Callers never write fetch directly. Web transport = cookie session
// (credentials: "include"); 401 -> silent refresh once -> retry; GET-only
// exponential retry on 5xx/network. Types come from @dub/types; error envelope
// from @dub/errors. (Design places this in packages/api-client; implemented
// inside apps/fe2-app-shell to keep this unit's work self-contained — see notes.)
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type { ErrorResponse } from "@dub/errors";
import { isErrorResponse } from "@dub/errors";
import type { gateway, member } from "@dub/types";
import type { DisplayableError } from "@dub/ui";

type MeResponse = gateway.MeResponse;
type BffHomeResponse = gateway.BffHomeResponse;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

// Self-service contract types come from the single source of truth (@dub/types), shared
// with the gateway handlers ([[dub-api-contract-sot]]) — never re-defined here. Aliased to
// the FE-local names the shell already imports (AccountSettingsDialog / participation).
/** Self profile edit payload (display name / avatar). `avatarUrl: null` clears the avatar. */
export type ProfileUpdateInput = gateway.MeProfileUpdateRequest;
/** Persisted self profile after an update — the caller reconciles its /me cache with this. */
export type ProfileUpdateResult = gateway.MeProfileResponse;
/** The self-editable slice of the signed-in user's own 参加届 (participation). The field
 *  descriptors that drive the edit UI live in features/participation (single source). */
export type SelfParticipation = member.SelfParticipation;

export interface RequestInput<TBody = unknown> {
  method: HttpMethod;
  path: `/api/v1/${string}`;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiClientConfig {
  baseUrl: string;
  onUnauthenticated?: () => void;
  requestIdFactory?: () => string;
  retry?: { maxRetries: number; baseDelayMs: number };
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const REQUEST_ID_HEADER = "x-dub-request-id";
const DEFAULT_RETRY = { maxRetries: 2, baseDelayMs: 200 };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly body: ErrorResponse;

  constructor(status: number, body: ErrorResponse) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error.code;
    this.details = body.error.details;
    this.body = body;
    if (body.error.requestId !== undefined) this.requestId = body.error.requestId;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** Design compat alias for the wire `requestId` correlation field. */
  get correlationId(): string | undefined {
    return this.requestId;
  }

  static isApiError(e: unknown): e is ApiError {
    return e instanceof ApiError;
  }
}

function synthEnvelope(code: string, message: string, retryable: boolean, requestId?: string): ErrorResponse {
  const error: ErrorResponse["error"] = { code, message, retryable };
  if (requestId !== undefined) error.requestId = requestId;
  return { error };
}

function buildUrl(baseUrl: string, path: string, query?: RequestInput["query"]): string {
  const full = new URL(baseUrl.replace(/\/$/, "") + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) full.searchParams.set(k, String(v));
    }
  }
  return full.toString();
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ResourceClient {
  get<TRes>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<TRes>;
  post<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  patch<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  delete<TRes>(path: string): Promise<TRes>;
}

/** A registered passkey as shown in アカウント設定 (no key material). */
export interface PasskeySummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
}

export interface ApiClient {
  request<TRes, TBody = unknown>(input: RequestInput<TBody>): Promise<TRes>;
  /** GET a binary resource as a Blob (attachments/exports). Same session + one-shot 401
   *  refresh as request(); the caller triggers the browser save (createObjectURL). */
  download(path: `/api/v1/${string}`): Promise<Blob>;
  auth: {
    passwordLogin(email: string, password: string): Promise<void>;
    /** STAGING ONLY: one-click demo sign-in (no password). Backed by the auth-service
     *  /auth/demo-login route which exists only when DEMO_AUTOLOGIN is set on staging;
     *  in production the route 404s. The login button is itself hidden unless the
     *  VITE_DEMO_AUTOLOGIN build flag is on, so production bundles never call this. */
    demoLogin(): Promise<void>;
    logout(): Promise<void>;
    me(): Promise<MeResponse>;
    /** Rotate the session PROACTIVELY, outside the 401 path (AuthProvider schedules this
     *  shortly before MeResponse.sessionExpiresAt so nothing ever 401s). Shares the
     *  single-flight latch with the reactive 401 branch, so a timer firing at the same
     *  moment as a request storm still produces exactly one POST /auth/refresh.
     *  Resolves true when the cookie was rotated; never throws. */
    refresh(): Promise<boolean>;
    /** Self password change (#5b): the logged-in user rotates their OWN password.
     *  The gateway re-verifies the session + current password before storing. */
    changePassword(currentPassword: string, newPassword: string): Promise<void>;
    /** Self profile update: the logged-in user edits their OWN display name / avatar.
     *  Posts to the gateway-owned POST /api/v1/me/profile (session-scoped to the caller
     *  — no target id, unlike FE7's admin roster PATCH /identity/users/:id). Returns the
     *  persisted display name + avatar so the caller can reconcile its optimistic cache.
     *  Backed by the gateway-owned POST /api/v1/me/profile (identity-roster self-profile
     *  route), session-scoped to the caller. */
    updateProfile(input: ProfileUpdateInput): Promise<ProfileUpdateResult>;
    /** The signed-in user's OWN 参加届 (self-service). GET returns the stored fields (all
     *  null when nothing was submitted yet); the update patches them. Session-scoped — no
     *  target id. Backed by the gateway GET/POST /api/v1/me/participation
     *  (member-service getSelfParticipation / updateSelfParticipation). */
    getSelfParticipation(): Promise<SelfParticipation>;
    updateSelfParticipation(input: Partial<SelfParticipation>): Promise<SelfParticipation>;
    /** Passkeys (WebAuthn). Raw JSON in/out — lib/passkey.tsx drives the browser half. */
    passkeys: {
      loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
      loginVerify(response: AuthenticationResponseJSON): Promise<void>;
      /** Step-up: the current password is required to start a registration. */
      registerOptions(password: string): Promise<PublicKeyCredentialCreationOptionsJSON>;
      registerVerify(response: RegistrationResponseJSON, label: string): Promise<{ passkey: PasskeySummary }>;
      list(): Promise<{ items: PasskeySummary[] }>;
      rename(id: string, label: string): Promise<void>;
      remove(id: string): Promise<void>;
    };
  };
  bff: { home(): Promise<BffHomeResponse> };
  events: ResourceClient;
  tasks: ResourceClient;
  gantt: ResourceClient;
  notifications: ResourceClient;
  chat: ResourceClient;
  identity: ResourceClient;
  files: ResourceClient;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = config.sleepImpl ?? defaultSleep;
  const retry = config.retry ?? DEFAULT_RETRY;

  async function doFetch<TBody>(input: RequestInput<TBody>): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(input.headers ?? {}),
    };
    if (config.requestIdFactory && headers[REQUEST_ID_HEADER] === undefined) {
      headers[REQUEST_ID_HEADER] = config.requestIdFactory();
    }
    const hasBody = input.body !== undefined && input.method !== "GET";
    if (hasBody) headers["content-type"] = "application/json";
    const init: RequestInit = {
      method: input.method,
      credentials: "include",
      headers,
    };
    if (hasBody) init.body = JSON.stringify(input.body);
    if (input.signal) init.signal = input.signal;
    return fetchImpl(buildUrl(config.baseUrl, input.path, input.query), init);
  }

  async function parseError(res: Response): Promise<ApiError> {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (isErrorResponse(body)) return new ApiError(res.status, body);
    // Non-envelope failure: synthesize a normalized envelope.
    const requestId = res.headers.get(REQUEST_ID_HEADER) ?? undefined;
    return new ApiError(
      res.status,
      synthEnvelope(res.status >= 500 ? "INTERNAL" : "CLIENT_CONTRACT_MISMATCH", res.statusText || "Request failed", res.status >= 500, requestId),
    );
  }

  /** The settled outcome of ONE refresh storm, shared by every caller that awaited it. */
  interface RefreshAttempt {
    ok: boolean;
    /** Fires config.onUnauthenticated at most once for this storm (latch is per-storm). */
    notifyUnauthenticated(): void;
  }

  // Single-flight refresh: when several requests 401 at once (e.g. /me + /bff/home
  // + chat all firing on a fresh mount past the access TTL), they must NOT each POST
  // /auth/refresh. Concurrent refreshes race the server-side token rotation and one
  // would come back "Invalid token", tearing down the shell. Instead they all await
  // the SAME in-flight refresh and then retry against the single rotated cookie.
  // Per-client closure (never a module global) so separate clients / tests don't share
  // state, and cleared on settle so a LATER access expiry can refresh again.
  let refreshInFlight: Promise<RefreshAttempt> | null = null;

  function attemptRefresh(): Promise<RefreshAttempt> {
    if (refreshInFlight) return refreshInFlight;
    const flight = (async (): Promise<RefreshAttempt> => {
      // Browser path: empty body {}, cookie-derived; Set-Cookie rotation server-side.
      let ok = false;
      try {
        const res = await fetchImpl(buildUrl(config.baseUrl, "/api/v1/auth/refresh"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      // One logout per storm. The shared promise alone is not enough: every waiting
      // caller independently reaches its own failure branch, so without this latch a
      // 10-request storm would fire onUnauthenticated 10 times (10 redirects/toasts).
      let notified = false;
      return {
        ok,
        notifyUnauthenticated: (): void => {
          if (notified) return;
          notified = true;
          config.onUnauthenticated?.();
        },
      };
    })();
    refreshInFlight = flight;
    void flight.then(
      () => {
        if (refreshInFlight === flight) refreshInFlight = null;
      },
      () => {
        if (refreshInFlight === flight) refreshInFlight = null;
      },
    );
    return flight;
  }

  async function requestOnce<TRes, TBody>(input: RequestInput<TBody>): Promise<TRes> {
    const isGet = input.method === "GET";
    let networkAttempts = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let res: Response;
      try {
        res = await doFetch(input);
      } catch (netErr) {
        // network failure: GET-only exponential retry
        if (isGet && networkAttempts < retry.maxRetries) {
          await sleep(retry.baseDelayMs * 2 ** networkAttempts);
          networkAttempts++;
          continue;
        }
        throw new ApiError(0, synthEnvelope("NETWORK_ERROR", netErr instanceof Error ? netErr.message : "Network error", true));
      }

      if (res.ok) {
        if (res.status === 204) return undefined as TRes;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as TRes;
      }

      // GET-only retry on 5xx
      if (isGet && res.status >= 500 && networkAttempts < retry.maxRetries) {
        await sleep(retry.baseDelayMs * 2 ** networkAttempts);
        networkAttempts++;
        continue;
      }

      throw await parseError(res);
    }
  }

  async function request<TRes, TBody = unknown>(input: RequestInput<TBody>): Promise<TRes> {
    try {
      return await requestOnce<TRes, TBody>(input);
    } catch (e) {
      // 401 branch judged by HTTP status ONLY (code-name independent).
      if (ApiError.isApiError(e) && e.status === 401) {
        const attempt = await attemptRefresh();
        if (attempt.ok) {
          try {
            return await requestOnce<TRes, TBody>(input);
          } catch (e2) {
            // Still 401 after a *successful* rotation = the session is genuinely gone.
            if (ApiError.isApiError(e2) && e2.status === 401) {
              attempt.notifyUnauthenticated();
            }
            throw e2;
          }
        }
        attempt.notifyUnauthenticated();
      }
      throw e;
    }
  }

  async function downloadOnce(path: `/api/v1/${string}`): Promise<Blob> {
    const res = await doFetch({ method: "GET", path });
    if (res.ok) return await res.blob();
    throw await parseError(res);
  }

  async function download(path: `/api/v1/${string}`): Promise<Blob> {
    try {
      return await downloadOnce(path);
    } catch (e) {
      if (ApiError.isApiError(e) && e.status === 401) {
        const attempt = await attemptRefresh();
        if (attempt.ok) {
          try {
            return await downloadOnce(path);
          } catch (e2) {
            if (ApiError.isApiError(e2) && e2.status === 401) attempt.notifyUnauthenticated();
            throw e2;
          }
        }
        attempt.notifyUnauthenticated();
      }
      throw e;
    }
  }

  function makeResource(prefix: string): ResourceClient {
    const p = (path: string): `/api/v1/${string}` => `/api/v1/${prefix}${path}` as `/api/v1/${string}`;
    return {
      get: <TRes,>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
        request<TRes>({ method: "GET", path: p(path), ...(query ? { query } : {}) }),
      post: <TRes, TBody>(path: string, body: TBody) => request<TRes, TBody>({ method: "POST", path: p(path), body }),
      patch: <TRes, TBody>(path: string, body: TBody) => request<TRes, TBody>({ method: "PATCH", path: p(path), body }),
      delete: <TRes,>(path: string) => request<TRes>({ method: "DELETE", path: p(path) }),
    };
  }

  return {
    request,
    download,
    auth: {
      // Company email+password login. The server sets the session cookie on 200;
      // the caller then re-enters the shell (a full nav lets /me pick up the cookie).
      passwordLogin: (email: string, password: string) =>
        request<void, { email: string; password: string }>({
          method: "POST",
          path: "/api/v1/auth/password/login",
          body: { email, password },
        }),
      demoLogin: () => request<void, Record<string, never>>({ method: "POST", path: "/api/v1/auth/demo-login", body: {} }),
      logout: () => request<void, Record<string, never>>({ method: "POST", path: "/api/v1/auth/logout", body: {} }),
      me: () => request<MeResponse>({ method: "GET", path: "/api/v1/me" }),
      // Deliberately does NOT notify onUnauthenticated on failure: a proactive refresh that
      // fails must not log the user out on its own (a transient network blip would then end
      // the session). The reactive 401 path stays the single place that tears the shell down.
      refresh: () => attemptRefresh().then((a) => a.ok),
      changePassword: (currentPassword: string, newPassword: string) =>
        request<void, { currentPassword: string; newPassword: string }>({
          method: "POST",
          path: "/api/v1/me/password",
          body: { currentPassword, newPassword },
        }),
      updateProfile: (input: ProfileUpdateInput) =>
        request<ProfileUpdateResult, ProfileUpdateInput>({
          method: "POST",
          path: "/api/v1/me/profile",
          body: input,
        }),
      getSelfParticipation: () => request<SelfParticipation>({ method: "GET", path: "/api/v1/me/participation" }),
      updateSelfParticipation: (input: Partial<SelfParticipation>) =>
        request<SelfParticipation, Partial<SelfParticipation>>({
          method: "POST",
          path: "/api/v1/me/participation",
          body: input,
        }),
      passkeys: {
        loginOptions: () =>
          request<PublicKeyCredentialRequestOptionsJSON, Record<string, never>>({ method: "POST", path: "/api/v1/auth/passkey/login/options", body: {} }),
        loginVerify: (response: AuthenticationResponseJSON) =>
          request<void, { response: AuthenticationResponseJSON }>({ method: "POST", path: "/api/v1/auth/passkey/login/verify", body: { response } }),
        registerOptions: (password: string) =>
          request<PublicKeyCredentialCreationOptionsJSON, { password: string }>({
            method: "POST",
            path: "/api/v1/auth/passkey/register/options",
            body: { password },
          }),
        registerVerify: (response: RegistrationResponseJSON, label: string) =>
          request<{ passkey: PasskeySummary }, { response: RegistrationResponseJSON; label: string }>({
            method: "POST",
            path: "/api/v1/auth/passkey/register/verify",
            body: { response, label },
          }),
        list: () => request<{ items: PasskeySummary[] }>({ method: "GET", path: "/api/v1/auth/passkeys" }),
        rename: (id: string, label: string) =>
          request<void, { label: string }>({ method: "PATCH", path: `/api/v1/auth/passkeys/${encodeURIComponent(id)}`, body: { label } }),
        remove: (id: string) => request<void>({ method: "DELETE", path: `/api/v1/auth/passkeys/${encodeURIComponent(id)}` }),
      },
    },
    bff: {
      home: () => request<BffHomeResponse>({ method: "GET", path: "/api/v1/bff/home" }),
    },
    events: makeResource("events"),
    tasks: makeResource("tasks"),
    gantt: makeResource("gantt"),
    notifications: makeResource("notifications"),
    chat: makeResource("chat"),
    identity: makeResource("identity"),
    files: makeResource("files"),
  };
}

// UI display bridge required by FE1 (theme5 1-4-4): ja copy from code.
const JA_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: "セッションの有効期限が切れました。再度ログインしてください。",
  FORBIDDEN: "この操作を行う権限がありません。",
  NOT_FOUND: "対象が見つかりませんでした。",
  VALIDATION_FAILED: "入力内容に誤りがあります。",
  CONFLICT: "他の変更と競合しました。最新の状態を再取得してください。",
  RATE_LIMITED: "リクエストが多すぎます。しばらくしてからお試しください。",
  NETWORK_ERROR: "ネットワークに接続できませんでした。",
  INTERNAL: "サーバーでエラーが発生しました。",
  CLIENT_CONTRACT_MISMATCH: "予期しない応答を受け取りました。",
  AUTH_PASSKEY_FAILED: "パスキーで確認できませんでした。もう一度お試しいただくか、パスワードでログインしてください。",
  AUTH_PASSKEY_DISABLED: "この環境ではパスキーを利用できません。パスワードでログインしてください。",
  AUTH_PASSKEY_DUPLICATE: "このパスキーはすでに登録されています。",
  AUTH_STEP_UP_FAILED: "パスワードが正しくありません。",
  AUTH_LAST_AUTH_METHOD: "最後のログイン手段は削除できません。",
};

export function toDisplayableError(e: ApiError): DisplayableError {
  const out: DisplayableError = {
    code: e.code,
    message: JA_BY_CODE[e.code] ?? e.message ?? "エラーが発生しました。",
  };
  // wire field = requestId; FE1 DisplayableError exposes it as correlationId (テーマ3裁定).
  if (e.requestId !== undefined) out.correlationId = e.requestId;
  return out;
}
