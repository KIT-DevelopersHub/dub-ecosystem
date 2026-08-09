// errors — client-side semi-open error model (mirrors the Swift 準開放 enum,
// design §6). Server errors arrive as @dub/errors ErrorResponse whose `code` is
// an OPEN set (CommonErrorCode | service codes like TASK_VERSION_CONFLICT). We
// never drop an unknown code: common codes get a typed `kind`, everything else
// falls through to `unknown` so the UI degrades instead of crashing.
import { CommonErrorCodes, isErrorResponse, type ErrorCode, type ErrorResponse } from "@dub/errors";

/** How the UI should react — the single branch point for §6's behaviour table. */
export type ClientErrorKind =
  | "reauth" // 401: silent refresh then S1 login
  | "forbidden" // 403: show read-only / hide capability UI
  | "validation" // 400 VALIDATION_FAILED: field errors
  | "conflict" // 409 (incl. *_VERSION_CONFLICT): rollback optimistic UI
  | "rate_limited" // 429: backoff, honour Retry-After
  | "upstream" // 502/504/UPSTREAM_*: retryable backoff
  | "sync_expired" // 410 *_SYNC_CURSOR_EXPIRED: full refetch
  | "offline" // transport failed (no response)
  | "unknown"; // any code/status we do not model — never crash

export interface DubClientError {
  readonly code: ErrorCode;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly kind: ClientErrorKind;
  readonly details?: unknown;
  readonly retryAfterSec?: number;
}

const UPSTREAM_CODES: ReadonlySet<string> = new Set([
  CommonErrorCodes.UPSTREAM_UNAVAILABLE,
  CommonErrorCodes.UPSTREAM_TIMEOUT,
]);

function kindFor(code: ErrorCode, status: number): ClientErrorKind {
  switch (code) {
    case CommonErrorCodes.UNAUTHENTICATED:
      return "reauth";
    case CommonErrorCodes.FORBIDDEN:
      return "forbidden";
    case CommonErrorCodes.VALIDATION_FAILED:
      return "validation";
    case CommonErrorCodes.CONFLICT:
      return "conflict";
    case CommonErrorCodes.RATE_LIMITED:
      return "rate_limited";
  }
  if (UPSTREAM_CODES.has(code)) return "upstream";
  // Open service codes: classify by suffix convention, then by HTTP status.
  if (code.endsWith("_VERSION_CONFLICT") || status === 409) return "conflict";
  if (code.endsWith("_SYNC_CURSOR_EXPIRED") || status === 410) return "sync_expired";
  if (status === 401) return "reauth";
  if (status === 403) return "forbidden";
  if (status === 400) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 504) return "upstream";
  return "unknown";
}

function retryAfterFrom(details: unknown): number | undefined {
  if (details !== null && typeof details === "object") {
    const v = (details as { retryAfterSec?: unknown }).retryAfterSec;
    if (typeof v === "number") return v;
  }
  return undefined;
}

/** Build a DubClientError from a decoded HTTP response body + status. */
export function fromResponseBody(status: number, body: unknown): DubClientError {
  if (isErrorResponse(body)) {
    const e = (body as ErrorResponse).error;
    const base: DubClientError = {
      code: e.code,
      status,
      message: e.message,
      retryable: e.retryable,
      kind: kindFor(e.code, status),
      details: e.details,
    };
    const retryAfterSec = retryAfterFrom(e.details);
    return retryAfterSec !== undefined ? { ...base, retryAfterSec } : base;
  }
  // Non-envelope body: treat as an unrecognised upstream failure (retryable).
  return {
    code: CommonErrorCodes.UPSTREAM_UNAVAILABLE,
    status: status >= 500 ? status : 502,
    message: "Upstream returned an unrecognized error body",
    retryable: true,
    kind: "upstream",
  };
}

/** Transport-level failure (no HTTP response at all) → offline, retryable. */
export function offlineError(cause?: unknown): DubClientError {
  const message = cause instanceof Error ? cause.message : "Network unavailable";
  return {
    code: "OFFLINE",
    status: 0,
    message,
    retryable: true,
    kind: "offline",
  };
}

export function isReauth(err: DubClientError): boolean {
  return err.kind === "reauth";
}
