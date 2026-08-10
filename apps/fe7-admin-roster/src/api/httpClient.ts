// Real fetch-backed ResourceClient. This is the production/real transport that
// SHIPS in the package (the sibling of api/mockClient.ts) — the standalone harness
// uses it when VITE_ROSTER_API_BASE is set, and it documents the exact wire
// behaviour FE2's injected ResourceClient must honour.
//
// Contract parity with the mock (design §6 error handling): every non-2xx and
// every network failure REJECTS with a typed `ErrorResponse` ({ error: { code,
// message, retryable, ... } }), never a bare Error. That is what lets
// lib/errorDisplay.presentError branch on `.code` identically whether the state
// came from the mock or a live gateway.
import {
  CommonErrorCodes,
  isErrorResponse,
  type CommonErrorCode,
  type ErrorResponse,
} from "@dub/errors";
import type { ResourceClient } from "../shell/contract";

export interface HttpClientOptions {
  /** Gateway origin/prefix prepended to the `/api/v1/*` paths. Default "" (same-origin). */
  baseUrl?: string;
  /** Injectable fetch (tests / non-browser hosts). Default: globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Extra headers merged into every request (e.g. an x-dub-request-id seed). */
  headers?: Record<string, string>;
  /** Cookie policy. Default "include" — the gateway auth cookie rides same-site. */
  credentials?: RequestCredentials;
}

// Non-ErrorResponse upstream bodies (proxies, HTML 502s, opaque 500s) are mapped
// to a common code by status so the UI still gets a stable branch.
const CODE_BY_STATUS: Record<number, CommonErrorCode> = {
  400: CommonErrorCodes.VALIDATION_FAILED,
  401: CommonErrorCodes.UNAUTHENTICATED,
  403: CommonErrorCodes.FORBIDDEN,
  404: CommonErrorCodes.NOT_FOUND,
  409: CommonErrorCodes.CONFLICT,
  412: CommonErrorCodes.PRECONDITION_FAILED,
  413: CommonErrorCodes.PAYLOAD_TOO_LARGE,
  429: CommonErrorCodes.RATE_LIMITED,
  500: CommonErrorCodes.INTERNAL,
  502: CommonErrorCodes.UPSTREAM_UNAVAILABLE,
  504: CommonErrorCodes.UPSTREAM_TIMEOUT,
};

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  CommonErrorCodes.UPSTREAM_UNAVAILABLE,
  CommonErrorCodes.UPSTREAM_TIMEOUT,
  CommonErrorCodes.RATE_LIMITED,
]);

function syntheticError(status: number, message: string): ErrorResponse {
  const code = CODE_BY_STATUS[status] ?? (status >= 500 ? CommonErrorCodes.UPSTREAM_UNAVAILABLE : CommonErrorCodes.INTERNAL);
  return { error: { code, message, retryable: RETRYABLE_CODES.has(code) } };
}

/** Serialize a query object to a search string, omitting undefined/null and empty. */
function toSearch(query?: Record<string, unknown>): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Construct a real ResourceClient over `fetch` against the gateway boundary. */
export function createHttpClient(options: HttpClientOptions = {}): ResourceClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetchFn ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("createHttpClient: no fetch implementation available (pass options.fetchFn)");
  }
  const credentials = options.credentials ?? "include";
  const extraHeaders = options.headers ?? {};

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = `${baseUrl}${path}${toSearch(opts.query)}`;
    const hasBody = opts.body !== undefined && method !== "GET" && method !== "DELETE";
    const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
    if (hasBody) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        credentials,
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (cause) {
      // Network-level failure (offline, DNS, CORS) — never surfaces a wire body.
      const message = cause instanceof Error ? cause.message : "Network request failed";
      return Promise.reject({
        error: { code: CommonErrorCodes.UPSTREAM_UNAVAILABLE, message, retryable: true },
      } satisfies ErrorResponse) as Promise<T>;
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined; // non-JSON body; treated as empty/opaque below
      }
    }

    if (!res.ok) {
      const errBody: ErrorResponse = isErrorResponse(parsed)
        ? parsed
        : syntheticError(res.status, res.statusText || `HTTP ${res.status}`);
      return Promise.reject(errBody) as Promise<T>;
    }

    // 204 / empty body (e.g. DELETE) — resolve undefined; callers typed as void ignore it.
    return parsed as T;
  }

  return {
    get: <T>(path: string, query?: Record<string, unknown>) => request<T>("GET", path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
    delete: (path: string) => request<void>("DELETE", path).then(() => undefined),
  };
}
