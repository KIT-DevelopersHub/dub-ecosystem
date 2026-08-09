// Service Binding client: typed calls, header injection, retry/timeout, upstream
// error restoration (via @dub/errors fromResponse — never re-implemented here).
import type { Fetcher } from "@cloudflare/workers-types";
import { DubError, fromResponse, isErrorResponse, CommonErrorCodes } from "@dub/errors";
import { HDR_IDEMPOTENCY_KEY } from "@dub/observability";
import { DUB_HEADERS, INTERNAL_MARKER, type RequestContext } from "./context";

export interface RetryPolicy {
  maxAttempts: number; // default 3 (1 try + 2 retries)
  baseDelayMs: number; // default 100
  maxDelayMs: number; // default 2000; exponential backoff + full jitter
  retryOn: (r: { status?: number; error?: unknown }) => boolean;
}

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  retryOn: ({ status, error }) => error !== undefined || (status !== undefined && DEFAULT_RETRY_STATUSES.has(status)),
};

export interface HttpHookRequestInfo {
  service: string;
  caller: string;
  method: string;
  path: string;
  requestId: string;
  attempt: number;
}
export interface HttpHookResponseInfo extends HttpHookRequestInfo {
  status: number;
  durationMs: number;
}
export interface HttpHookRetryInfo extends HttpHookRequestInfo {
  status?: number;
  error?: unknown;
  delayMs: number;
}
export interface HttpHooks {
  onRequest?: (info: HttpHookRequestInfo) => void;
  onResponse?: (info: HttpHookResponseInfo) => void;
  onRetry?: (info: HttpHookRetryInfo) => void;
}

export interface ServiceClientOptions {
  service: string; // callee name
  caller: string; // own service name -> x-dub-caller
  timeoutMs?: number; // per attempt, default 5000
  retry?: Partial<RetryPolicy>;
  hooks?: HttpHooks;
  baseUrl?: string; // default "https://svc" (Service Bindings ignore host)
}

export interface CallOptions {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  idempotencyKey?: string; // enables retry for POST/PATCH/DELETE
  retry?: Partial<RetryPolicy> | false;
  signal?: AbortSignal;
}

export interface ServiceClient {
  get<TRes>(ctx: RequestContext, path: string, opts?: CallOptions): Promise<TRes>;
  post<TRes, TReq = unknown>(ctx: RequestContext, path: string, body: TReq, opts?: CallOptions): Promise<TRes>;
  patch<TRes, TReq = unknown>(ctx: RequestContext, path: string, body: TReq, opts?: CallOptions): Promise<TRes>;
  delete<TRes>(ctx: RequestContext, path: string, opts?: CallOptions): Promise<TRes>;
}

export class DubHttpError extends DubError {
  readonly callee: string;
  readonly upstreamCode?: string;
  readonly attempts: number;
  constructor(code: string, message: string, callee: string, attempts: number, status: number, upstreamCode?: string) {
    super(code, message, { status, service: callee, retryable: true });
    this.name = "DubHttpError";
    this.callee = callee;
    this.attempts = attempts;
    this.upstreamCode = upstreamCode;
  }
}
export class DubHttpTimeoutError extends DubHttpError {
  constructor(callee: string, attempts: number) {
    super(CommonErrorCodes.UPSTREAM_TIMEOUT, `Upstream timeout: ${callee}`, callee, attempts, 504);
    this.name = "DubHttpTimeoutError";
  }
}
export class DubHttpUnavailableError extends DubHttpError {
  constructor(callee: string, attempts: number, upstreamCode?: string) {
    super(CommonErrorCodes.UPSTREAM_UNAVAILABLE, `Upstream unavailable: ${callee}`, callee, attempts, 502, upstreamCode);
    this.name = "DubHttpUnavailableError";
  }
}

function backoff(attempt: number, policy: RetryPolicy): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp); // full jitter
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildUrl(baseUrl: string, path: string, query?: CallOptions["query"]): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "DELETE"]);

export function createServiceClient(binding: Fetcher, opts: ServiceClientOptions): ServiceClient {
  const baseUrl = opts.baseUrl ?? "https://svc";
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
  const perAttemptTimeout = opts.timeoutMs ?? 5000;

  async function call<TRes>(method: string, ctx: RequestContext, path: string, body: unknown, o: CallOptions = {}): Promise<TRes> {
    const url = buildUrl(baseUrl, path, o.query);
    const headers = new Headers(o.headers);
    headers.set(DUB_HEADERS.requestId, ctx.requestId);
    headers.set(DUB_HEADERS.caller, opts.caller);
    headers.set(DUB_HEADERS.internal, INTERNAL_MARKER);
    if (ctx.userId) headers.set(DUB_HEADERS.userId, ctx.userId);
    if (o.idempotencyKey) headers.set(HDR_IDEMPOTENCY_KEY, o.idempotencyKey);
    if (body !== undefined) headers.set("content-type", "application/json");

    const retryEnabled =
      o.retry !== false && (IDEMPOTENT_METHODS.has(method) || o.idempotencyKey !== undefined || o.retry !== undefined);
    const effPolicy: RetryPolicy = o.retry ? { ...policy, ...o.retry } : policy;
    const maxAttempts = retryEnabled ? effPolicy.maxAttempts : 1;
    const timeoutMs = o.timeoutMs ?? perAttemptTimeout;

    let attempt = 0;
    let lastStatus: number | undefined;
    while (attempt < maxAttempts) {
      attempt++;
      opts.hooks?.onRequest?.({ service: opts.service, caller: opts.caller, method, path, requestId: ctx.requestId, attempt });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const started = Date.now();
      try {
        const req = new Request(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: o.signal ?? ac.signal,
        });
        // Cloudflare Fetcher.fetch accepts a standard Request.
        const res = await (binding as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(req);
        clearTimeout(timer);
        lastStatus = res.status;
        opts.hooks?.onResponse?.({ service: opts.service, caller: opts.caller, method, path, requestId: ctx.requestId, attempt, status: res.status, durationMs: Date.now() - started });

        if (res.ok) {
          if (res.status === 204) return undefined as TRes;
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as TRes;
        }

        // non-2xx: retry raw status if policy says so and attempts remain
        if (retryEnabled && attempt < maxAttempts && effPolicy.retryOn({ status: res.status })) {
          const delay = backoff(attempt, effPolicy);
          opts.hooks?.onRetry?.({ service: opts.service, caller: opts.caller, method, path, requestId: ctx.requestId, attempt, status: res.status, delayMs: delay });
          await sleep(delay);
          continue;
        }
        // terminal non-2xx: restore business error (code passthrough) or normalize
        const parsed = await safeJson(res);
        if (isErrorResponse(parsed)) throw fromResponse(res.status, parsed);
        throw new DubHttpUnavailableError(opts.service, attempt);
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DubError && !(err instanceof DubHttpError)) throw err; // restored business error
        const aborted = err instanceof Error && err.name === "AbortError";
        if (retryEnabled && attempt < maxAttempts && effPolicy.retryOn({ error: err })) {
          const delay = backoff(attempt, effPolicy);
          opts.hooks?.onRetry?.({ service: opts.service, caller: opts.caller, method, path, requestId: ctx.requestId, attempt, error: err, delayMs: delay });
          await sleep(delay);
          continue;
        }
        if (err instanceof DubHttpError) throw err;
        throw aborted ? new DubHttpTimeoutError(opts.service, attempt) : new DubHttpUnavailableError(opts.service, attempt);
      }
    }
    // attempts exhausted
    if (lastStatus === 429) throw new DubError(CommonErrorCodes.RATE_LIMITED, "Rate limited (retries exhausted)", { status: 429, details: { retryAfterSec: 1 } });
    throw new DubHttpUnavailableError(opts.service, attempt);
  }

  return {
    get: <TRes>(ctx: RequestContext, path: string, o?: CallOptions) => call<TRes>("GET", ctx, path, undefined, o),
    post: <TRes, TReq = unknown>(ctx: RequestContext, path: string, body: TReq, o?: CallOptions) => call<TRes>("POST", ctx, path, body, o),
    patch: <TRes, TReq = unknown>(ctx: RequestContext, path: string, body: TReq, o?: CallOptions) => call<TRes>("PATCH", ctx, path, body, o),
    delete: <TRes>(ctx: RequestContext, path: string, o?: CallOptions) => call<TRes>("DELETE", ctx, path, undefined, o),
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** External HTTPS with the same retry/timeout discipline; no x-dub-* headers attached. */
export async function retryFetch(
  input: string | URL | Request,
  init?: RequestInit & { timeoutMs?: number; retry?: Partial<RetryPolicy> },
): Promise<Response> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...init?.retry };
  const timeoutMs = init?.timeoutMs ?? 5000;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < policy.maxAttempts) {
    attempt++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: init?.signal ?? ac.signal });
      clearTimeout(timer);
      if (!res.ok && attempt < policy.maxAttempts && policy.retryOn({ status: res.status })) {
        await sleep(backoff(attempt, policy));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < policy.maxAttempts && policy.retryOn({ error: err })) {
        await sleep(backoff(attempt, policy));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("retryFetch exhausted");
}

export type DubHttpOwnErrorCode = "HTTP_CONTEXT_MISSING";
