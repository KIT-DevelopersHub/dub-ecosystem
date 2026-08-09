// @dub/errors/wire — the wire-only surface (types + code constants) for FE2 / MO3.
// Kept import-free so front-ends can pull error shapes without the runtime class.

export const CommonErrorCodes = {
  UNAUTHENTICATED: "UNAUTHENTICATED", // 401
  FORBIDDEN: "FORBIDDEN", // 403
  NOT_FOUND: "NOT_FOUND", // 404
  VALIDATION_FAILED: "VALIDATION_FAILED", // 400
  CONFLICT: "CONFLICT", // 409
  PRECONDITION_FAILED: "PRECONDITION_FAILED", // 412
  RATE_LIMITED: "RATE_LIMITED", // 429
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE", // 413
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE", // 502
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT", // 504
  INTERNAL: "INTERNAL", // 500
} as const;

export type CommonErrorCode = keyof typeof CommonErrorCodes;

// Service-specific codes are the open half: `<SERVICE>_<REASON>` SCREAMING_SNAKE
// (e.g. "TASK_CYCLE_DETECTED", "AUTH_INVALID_TOKEN"). The registry/catalog is P2.
export type ErrorCode = CommonErrorCode | (string & {});

/** code -> HTTP status for the common codes (service codes pass status explicitly). */
export const STATUS_BY_CODE: Record<CommonErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_TIMEOUT: 504,
  INTERNAL: 500,
};

/** validation details standard shape (FE form-error rendering depends on it). */
export interface FieldError {
  field: string; // "title" / "items[2].due"
  reason: string; // machine-readable ("required", "too_long", ...)
  message?: string;
}

/** RATE_LIMITED details standard shape (toResponse reads it into Retry-After). */
export interface RateLimitDetails {
  retryAfterSec: number;
}

/** The single wire form all services / gateway / FE depend on (theme3 D7). */
export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string; // x-dub-request-id origin (gateway/MO3 minted)
    service?: string;
    retryable: boolean;
  };
}

/** Compat alias (legacy FE2 reference name); identical to ErrorResponse. */
export type DubErrorBody = ErrorResponse;

export function isErrorResponse(body: unknown): body is ErrorResponse {
  if (body === null || typeof body !== "object") return false;
  const e = (body as { error?: unknown }).error;
  if (e === null || typeof e !== "object") return false;
  const err = e as Record<string, unknown>;
  return typeof err.code === "string" && typeof err.message === "string" && typeof err.retryable === "boolean";
}
