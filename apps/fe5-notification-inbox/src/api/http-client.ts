// Real HTTP ApiClient — a fetch-backed implementation of the FE2 `ApiClient`
// surface (contracts/fe2). Until FE2's `@dub/api-client` is resolvable from FE5
// (see contracts/fe2 header), this lets FE5 talk to the real notification
// gateway directly: it injects the auth header + a correlation id, serialises
// query params, and normalises error bodies into the ApiError shape FE5's
// error handling expects (code / status / requestId / retryable / details).
//
// `fetchImpl` and the token/correlation-id providers are injected so this is
// unit-testable without a network and swappable by the SPA shell.

import { isErrorResponse } from "@dub/errors";
import type { ApiClient, ApiError } from "../contracts/fe2";

const DEFAULT_REQUEST_ID_HEADER = "x-dub-request-id";

// HTTP status -> a sensible common error code when the body is not the standard
// ErrorResponse wire shape (e.g. a gateway 502 HTML page).
const FALLBACK_CODE_BY_STATUS: Record<number, string> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
  502: "UPSTREAM_UNAVAILABLE",
  504: "UPSTREAM_TIMEOUT",
  500: "INTERNAL",
};

export interface HttpApiClientConfig {
  // Prepended to every path. Default "" (same origin — paths are absolute
  // gateway paths like "/api/v1/notifications/...").
  baseUrl?: string;
  getAuthToken?: () => string | null | undefined;
  correlationId?: () => string;
  fetchImpl?: typeof fetch;
  requestIdHeader?: string; // default "x-dub-request-id"
}

export class HttpApiError extends Error implements ApiError {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(init: {
    code: string;
    status: number;
    message: string;
    retryable?: boolean;
    requestId?: string;
    details?: unknown;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    this.details = init.details;
  }
}

function randomCorrelationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const base = `${baseUrl}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, typeof value === "string" ? value : String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function createHttpApiClient(config: HttpApiClientConfig = {}): ApiClient {
  const baseUrl = config.baseUrl ?? "";
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const requestIdHeader = config.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER;
  const correlationId = config.correlationId ?? randomCorrelationId;

  if (typeof fetchImpl !== "function") {
    throw new Error("createHttpApiClient: no fetch implementation available");
  }

  async function toApiError(res: Response, requestId: string): Promise<HttpApiError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body — fall through to the status-based fallback
    }
    if (isErrorResponse(body)) {
      const e = body.error;
      return new HttpApiError({
        code: e.code,
        status: res.status,
        message: e.message,
        retryable: e.retryable,
        requestId: e.requestId ?? requestId,
        details: e.details,
      });
    }
    return new HttpApiError({
      code: FALLBACK_CODE_BY_STATUS[res.status] ?? "UPSTREAM_UNAVAILABLE",
      status: res.status,
      message: res.statusText || `HTTP ${res.status}`,
      retryable: res.status >= 500,
      requestId,
    });
  }

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; hasBody?: boolean },
  ): Promise<T> {
    const requestId = correlationId();
    const headers: Record<string, string> = {
      accept: "application/json",
      [requestIdHeader]: requestId,
    };
    const token = config.getAuthToken?.();
    if (token) headers["authorization"] = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (opts.hasBody) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body ?? {});
    }

    const url = buildUrl(baseUrl, path, opts.query);
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      // Transport failure (offline / DNS / abort) — surface as retryable upstream.
      throw new HttpApiError({
        code: "UPSTREAM_UNAVAILABLE",
        status: 0,
        message: err instanceof Error ? err.message : "Network request failed",
        retryable: true,
        requestId,
      });
    }

    const responseRequestId = res.headers.get(requestIdHeader) ?? requestId;
    if (!res.ok) throw await toApiError(res, responseRequestId);

    // 204 / empty body (markRead, markAllRead, updatePreferences) -> void.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    get<T>(path: string, query?: Record<string, unknown>) {
      return request<T>("GET", path, query !== undefined ? { query } : {});
    },
    post<T>(path: string, body?: unknown) {
      return request<T>("POST", path, { body, hasBody: true });
    },
    patch<T>(path: string, body?: unknown) {
      return request<T>("PATCH", path, { body, hasBody: true });
    },
  };
}
