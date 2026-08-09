// @dub/errors — unified error type + wire formatting + boundary reconstruction.
// runtime dependency ZERO (底辺パッケージ). hono is a type-only optional peer.

import type { ErrorHandler } from "hono";
import {
  CommonErrorCodes,
  STATUS_BY_CODE,
  isErrorResponse,
  type CommonErrorCode,
  type ErrorCode,
  type ErrorResponse,
  type DubErrorBody,
  type FieldError,
  type RateLimitDetails,
} from "./wire";

export {
  CommonErrorCodes,
  STATUS_BY_CODE,
  isErrorResponse,
  type CommonErrorCode,
  type ErrorCode,
  type ErrorResponse,
  type DubErrorBody,
  type FieldError,
  type RateLimitDetails,
};

const DEFAULT_REQUEST_ID_HEADER = "x-dub-request-id";
const RETRYABLE_BY_DEFAULT: ReadonlySet<string> = new Set([
  CommonErrorCodes.UPSTREAM_UNAVAILABLE,
  CommonErrorCodes.UPSTREAM_TIMEOUT,
  CommonErrorCodes.RATE_LIMITED,
]);

export interface DubErrorOptions {
  status?: number; // default: resolved from code via STATUS_BY_CODE, else 500
  details?: unknown;
  retryable?: boolean; // default: derived from code
  cause?: unknown; // original error, never serialized to wire
  service?: string;
}

function statusForCode(code: ErrorCode, explicit?: number): number {
  if (typeof explicit === "number") return explicit;
  return (STATUS_BY_CODE as Record<string, number>)[code] ?? 500;
}

function retryableForCode(code: ErrorCode, explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  return RETRYABLE_BY_DEFAULT.has(code);
}

export class DubError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly service?: string;

  constructor(code: ErrorCode, message: string, options: DubErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DubError";
    this.code = code;
    this.status = statusForCode(code, options.status);
    this.details = options.details;
    this.retryable = retryableForCode(code, options.retryable);
    this.service = options.service;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDubError(value: unknown): value is DubError {
  return value instanceof DubError;
}

/** Normalize any thrown value into a DubError (INTERNAL/500/non-retryable). */
export function wrapUnknown(value: unknown, service?: string): DubError {
  if (isDubError(value)) return value;
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "Internal error";
  return new DubError(CommonErrorCodes.INTERNAL, message, {
    cause: value,
    service,
    retryable: false,
    status: 500,
  });
}

/** Factory shorthands for the frequent common codes. */
export const errors = {
  unauthenticated(message = "Unauthenticated"): DubError {
    return new DubError(CommonErrorCodes.UNAUTHENTICATED, message);
  },
  forbidden(message = "Forbidden", details?: unknown): DubError {
    return new DubError(CommonErrorCodes.FORBIDDEN, message, { details });
  },
  notFound(resource: string, id?: string): DubError {
    const msg = id ? `${resource} not found: ${id}` : `${resource} not found`;
    return new DubError(CommonErrorCodes.NOT_FOUND, msg, { details: { resource, id } });
  },
  validationFailed(details: FieldError[], message = "Validation failed"): DubError {
    return new DubError(CommonErrorCodes.VALIDATION_FAILED, message, { details });
  },
  conflict(message: string, details?: unknown): DubError {
    return new DubError(CommonErrorCodes.CONFLICT, message, { details });
  },
  preconditionFailed(message: string): DubError {
    return new DubError(CommonErrorCodes.PRECONDITION_FAILED, message);
  },
  rateLimited(retryAfterSec = 1): DubError {
    const details: RateLimitDetails = { retryAfterSec };
    return new DubError(CommonErrorCodes.RATE_LIMITED, "Rate limited", { details });
  },
  upstreamUnavailable(target: string, cause?: unknown): DubError {
    return new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, `Upstream unavailable: ${target}`, { cause, service: target });
  },
  upstreamTimeout(target: string, cause?: unknown): DubError {
    return new DubError(CommonErrorCodes.UPSTREAM_TIMEOUT, `Upstream timeout: ${target}`, { cause, service: target });
  },
  internal(message = "Internal error", cause?: unknown): DubError {
    return new DubError(CommonErrorCodes.INTERNAL, message, { cause, retryable: false });
  },
};

export interface FormatOptions {
  requestId?: string;
  /** replace 5xx message with "Internal error" and drop details (default true). */
  redactInternal?: boolean;
}

export function toErrorResponse(err: unknown, opts: FormatOptions = {}): ErrorResponse {
  const de = wrapUnknown(err);
  const redact = opts.redactInternal ?? true;
  const is5xx = de.status >= 500;
  const body: ErrorResponse["error"] = {
    code: de.code,
    message: redact && is5xx ? "Internal error" : de.message,
    retryable: de.retryable,
  };
  if (!(redact && is5xx) && de.details !== undefined) body.details = de.details;
  if (opts.requestId !== undefined) body.requestId = opts.requestId;
  if (de.service !== undefined) body.service = de.service;
  return { error: body };
}

export function toResponse(err: unknown, opts: FormatOptions = {}): Response {
  const de = wrapUnknown(err);
  const payload = toErrorResponse(de, opts);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (de.code === CommonErrorCodes.RATE_LIMITED && isRateLimitDetails(de.details)) {
    headers["retry-after"] = String(de.details.retryAfterSec);
  }
  return new Response(JSON.stringify(payload), { status: de.status, headers });
}

function isRateLimitDetails(d: unknown): d is RateLimitDetails {
  return d !== null && typeof d === "object" && typeof (d as RateLimitDetails).retryAfterSec === "number";
}

/**
 * Reconstruct a DubError from an internal HTTP response. This is the ONLY
 * restoration implementation (@dub/http calls it, never re-implements). Bodies
 * that are not ErrorResponse-shaped normalize to UPSTREAM_UNAVAILABLE.
 */
export function fromResponse(status: number, body: unknown): DubError {
  if (isErrorResponse(body)) {
    const e = body.error;
    return new DubError(e.code, e.message, {
      status,
      details: e.details,
      retryable: e.retryable,
      service: e.service,
    });
  }
  return new DubError(CommonErrorCodes.UPSTREAM_UNAVAILABLE, "Upstream returned an unrecognized error body", {
    status: status >= 500 ? status : 502,
    retryable: true,
  });
}

/**
 * Durable retry classification (Queue consumer visibility + restored-DubError
 * branching). Intentionally a different layer from @dub/http RetryPolicy.retryOn
 * (which bets on raw 500s). INTERNAL=false here is not a contradiction.
 */
export function isRetryable(err: unknown): boolean {
  if (isDubError(err)) return err.retryable;
  return false;
}

/** Hono onError handler: format any uncaught throw into the wire ErrorResponse. */
export function dubErrorHandler(opts: {
  service: string;
  redactInternal?: boolean;
  requestIdHeader?: string;
}): ErrorHandler {
  const header = opts.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER;
  return (err, c) => {
    const requestId = c.req.header(header) ?? undefined;
    const de = wrapUnknown(err, opts.service);
    const withService = de.service ? de : new DubError(de.code, de.message, {
      status: de.status,
      details: de.details,
      retryable: de.retryable,
      cause: de,
      service: opts.service,
    });
    return toResponse(withService, {
      requestId,
      ...(opts.redactInternal !== undefined ? { redactInternal: opts.redactInternal } : {}),
    });
  };
}

/** Header constant used by dubErrorHandler default; the canonical source is @dub/observability. */
export const DEFAULT_REQUEST_ID_HEADER_NAME = DEFAULT_REQUEST_ID_HEADER;
