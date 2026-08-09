// @dub/api-client — the single gateway call surface shared by every FE app.
//
// Callers never write `fetch` directly. Web transport = cookie session
// (`credentials: "include"`); a 401 triggers one silent refresh then a single
// retry; GET-only exponential retry on 5xx / network failure. Wire I/O types come
// from @dub/types; the error envelope + boundary reconstruction (`fromResponse`)
// come from @dub/errors. The only non-error UI dependency is `DisplayableError`,
// a projection of the error envelope that FE1 (@dub/ui) renders — its shape is
// mirrored here so this package depends solely on @dub/types + @dub/errors.
import { fromResponse, isErrorResponse } from "@dub/errors";
import type { DubError, ErrorResponse } from "@dub/errors";
import type { common, gateway } from "@dub/types";

type MeResponse = gateway.MeResponse;
type BffHomeResponse = gateway.BffHomeResponse;
type Paginated<T> = common.Paginated<T>;

// auth-service exposes AuthLoginStartRequest but no frozen Response type yet;
// the login-start reply is the OAuth authorize URL to redirect the browser to.
export interface AuthLoginStartResponse {
  authorizeUrl: string;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestInput<TBody = unknown> {
  method: HttpMethod;
  path: `/api/v1/${string}`;
  body?: TBody;
  query?: QueryParams;
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

/** FE-local pseudo error codes (not part of the @dub/errors wire catalog). */
export const CLIENT_ERROR_CODES = {
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

const REQUEST_ID_HEADER = "x-dub-request-id";
const DEFAULT_RETRY = { maxRetries: 2, baseDelayMs: 200 };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly body: ErrorResponse;

  constructor(status: number, body: ErrorResponse) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error.code;
    this.details = body.error.details;
    this.retryable = body.error.retryable;
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

/** Project a reconstructed @dub/errors DubError back onto the wire envelope. */
function envelopeFromDubError(err: DubError, requestId?: string): ErrorResponse {
  const error: ErrorResponse["error"] = {
    code: err.code,
    message: err.message,
    retryable: err.retryable,
  };
  if (err.details !== undefined) error.details = err.details;
  if (err.service !== undefined) error.service = err.service;
  if (requestId !== undefined) error.requestId = requestId;
  return { error };
}

function networkEnvelope(message: string): ErrorResponse {
  return { error: { code: CLIENT_ERROR_CODES.NETWORK_ERROR, message, retryable: true } };
}

function buildUrl(baseUrl: string, path: string, query?: QueryParams): string {
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
  get<TRes>(path: string, query?: QueryParams): Promise<TRes>;
  /** GET a cursor-paginated collection ({ items, nextCursor }). */
  list<TItem>(path: string, query?: QueryParams): Promise<Paginated<TItem>>;
  post<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  patch<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  put<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  delete<TRes>(path: string): Promise<TRes>;
}

export interface ApiClient {
  request<TRes, TBody = unknown>(input: RequestInput<TBody>): Promise<TRes>;
  auth: {
    loginStart(redirectPath?: string): Promise<AuthLoginStartResponse>;
    logout(): Promise<void>;
    me(): Promise<MeResponse>;
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
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    // Well-formed envelope: keep it verbatim so the origin requestId survives.
    if (isErrorResponse(body)) return new ApiError(res.status, body);
    // Non-envelope failure: let @dub/errors normalize it (fromResponse maps an
    // unrecognized body to UPSTREAM_UNAVAILABLE / retryable), then re-project.
    const requestId = res.headers.get(REQUEST_ID_HEADER) ?? undefined;
    const dubErr = fromResponse(res.status, body);
    return new ApiError(dubErr.status, envelopeFromDubError(dubErr, requestId));
  }

  async function attemptRefresh(): Promise<boolean> {
    // Browser path: empty body {}, cookie-derived; Set-Cookie rotation server-side.
    try {
      const res = await fetchImpl(buildUrl(config.baseUrl, "/api/v1/auth/refresh"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok;
    } catch {
      return false;
    }
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
        throw new ApiError(0, networkEnvelope(netErr instanceof Error ? netErr.message : "Network error"));
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
        const refreshed = await attemptRefresh();
        if (refreshed) {
          try {
            return await requestOnce<TRes, TBody>(input);
          } catch (e2) {
            if (ApiError.isApiError(e2) && e2.status === 401) {
              config.onUnauthenticated?.();
            }
            throw e2;
          }
        }
        config.onUnauthenticated?.();
      }
      throw e;
    }
  }

  function makeResource(prefix: string): ResourceClient {
    const p = (path: string): `/api/v1/${string}` => `/api/v1/${prefix}${path}` as `/api/v1/${string}`;
    return {
      get: <TRes,>(path: string, query?: QueryParams) =>
        request<TRes>({ method: "GET", path: p(path), ...(query ? { query } : {}) }),
      list: <TItem,>(path: string, query?: QueryParams) =>
        request<Paginated<TItem>>({ method: "GET", path: p(path), ...(query ? { query } : {}) }),
      post: <TRes, TBody>(path: string, body: TBody) => request<TRes, TBody>({ method: "POST", path: p(path), body }),
      patch: <TRes, TBody>(path: string, body: TBody) => request<TRes, TBody>({ method: "PATCH", path: p(path), body }),
      put: <TRes, TBody>(path: string, body: TBody) => request<TRes, TBody>({ method: "PUT", path: p(path), body }),
      delete: <TRes,>(path: string) => request<TRes>({ method: "DELETE", path: p(path) }),
    };
  }

  return {
    request,
    auth: {
      loginStart: (redirectPath?: string) =>
        request<AuthLoginStartResponse, { redirectUri: string; client: "web" }>({
          method: "POST",
          path: "/api/v1/auth/login",
          body: { redirectUri: redirectPath ?? "/", client: "web" },
        }),
      logout: () => request<void, Record<string, never>>({ method: "POST", path: "/api/v1/auth/logout", body: {} }),
      me: () => request<MeResponse>({ method: "GET", path: "/api/v1/me" }),
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

// ---- DisplayableError bridge (FE1 / @dub/ui theme5 1-4-4) -------------------
// FE1 renders errors from this projection. Its shape is mirrored here (rather
// than imported from @dub/ui) so this package stays a leaf over @dub/types +
// @dub/errors; when the apps wire it up the structural shape matches @dub/ui.
export interface DisplayableError {
  title: string;
  description: string;
  code?: string;
  requestId?: string; // shown for support correlation
}

const JA_BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: "セッションの有効期限が切れました。再度ログインしてください。",
  FORBIDDEN: "この操作を行う権限がありません。",
  NOT_FOUND: "対象が見つかりませんでした。",
  VALIDATION_FAILED: "入力内容に誤りがあります。",
  CONFLICT: "他の変更と競合しました。最新の状態を再取得してください。",
  PRECONDITION_FAILED: "前提条件を満たしていません。最新の状態を再取得してください。",
  RATE_LIMITED: "リクエストが多すぎます。しばらくしてからお試しください。",
  PAYLOAD_TOO_LARGE: "データ量が大きすぎます。",
  UPSTREAM_UNAVAILABLE: "サービスに一時的に接続できませんでした。",
  UPSTREAM_TIMEOUT: "応答がタイムアウトしました。しばらくしてからお試しください。",
  NETWORK_ERROR: "ネットワークに接続できませんでした。",
  INTERNAL: "サーバーでエラーが発生しました。",
};

export function toDisplayableError(e: ApiError): DisplayableError {
  const out: DisplayableError = {
    title: "エラー",
    description: JA_BY_CODE[e.code] ?? e.message ?? "エラーが発生しました。",
    code: e.code,
  };
  if (e.requestId !== undefined) out.requestId = e.requestId;
  return out;
}

// Re-export the wire error envelope so callers can type-narrow without a direct
// @dub/errors import.
export type { ErrorResponse } from "@dub/errors";
