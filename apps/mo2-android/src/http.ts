// HttpTransport — the low-level request executor (core:network in §2-2). Framework
// -agnostic over `fetch`; injectable FetchFn for tests (MockWebServer analog).
// Attaches Bearer, parses JSON, and normalizes failures to AppError (throws
// AppErrorException). Never logs token/PII (§6 機密).
import { MO3_BASE_URL, MOBILE_API_PREFIX } from "./config";
import { AppErrorException, mapHttpError, mapNetworkError } from "./errors";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string; // relative to MOBILE_API_PREFIX, e.g. "/bff/home"
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

function buildUrl(path: string, query?: RequestSpec["query"]): string {
  const url = new URL(`${MOBILE_API_PREFIX}${path}`, MO3_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export class HttpTransport {
  constructor(private readonly fetchFn: FetchFn) {}

  /** Execute a request with the given bearer token; T is the parsed JSON body. */
  async send<T>(spec: RequestSpec, token: string | null): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(spec.body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(buildUrl(spec.path, spec.query), init);
    } catch (cause) {
      throw new AppErrorException(mapNetworkError(cause));
    }

    if (res.status === 204) return undefined as T;

    let parsed: unknown = undefined;
    const text = await res.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      throw new AppErrorException(mapHttpError(res.status, parsed, (n) => res.headers.get(n)));
    }
    return parsed as T;
  }
}
