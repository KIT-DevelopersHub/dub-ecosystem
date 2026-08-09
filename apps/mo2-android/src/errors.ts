// ErrorMapper — @dub/errors envelope -> client-side AppError (§6 of MO2-android).
// Open-ended: unknown/unmapped codes and statuses fall through to Server.
// This is the TS port of the Kotlin `sealed interface AppError`; a Kotlin
// port mirrors these branches 1:1 (open-ended enum for ErrorCode).
import { isErrorResponse, type ErrorResponse } from "@dub/errors";

export type AppError =
  | { kind: "Unauthorized"; reAuth: boolean } // 401 -> refresh once, then re-login
  | { kind: "Forbidden"; code: string } // 403 -> hide/disable UI
  | { kind: "Conflict"; serverVersion: number | null } // 409 -> rollback optimistic UI, refetch
  | { kind: "Validation"; fields: Record<string, string> } // 400
  | { kind: "RateLimited"; retryAfterSec: number } // 429 -> honor Retry-After, exp backoff (max 2)
  | { kind: "Network"; retryable: boolean } // timeout/offline -> cached view + banner
  | { kind: "Server"; code: string; requestId: string | null }; // 5xx / unknown code -> show requestId
// 後段: SyncCursorExpired (410 MOBILE_SYNC_CURSOR_EXPIRED -> full resync) は /sync 実装波で追加。

/** Header accessor abstraction so this is portable off `fetch` Response. */
export type HeaderGetter = (name: string) => string | null;

const NO_HEADERS: HeaderGetter = () => null;

interface FieldErrorLike {
  field: string;
  reason: string;
  message?: string;
}

function extractFields(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(details)) {
    for (const d of details as FieldErrorLike[]) {
      if (d && typeof d.field === "string") {
        out[d.field] = d.message ?? d.reason ?? "invalid";
      }
    }
  }
  return out;
}

function retryAfterFromDetails(details: unknown): number | null {
  if (details && typeof details === "object" && "retryAfterSec" in details) {
    const v = (details as { retryAfterSec: unknown }).retryAfterSec;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function serverVersionFromDetails(details: unknown): number | null {
  if (details && typeof details === "object") {
    const rec = details as Record<string, unknown>;
    for (const k of ["serverVersion", "version", "currentVersion"]) {
      const v = rec[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/** Map an HTTP status + (optional) parsed body + headers to an AppError. */
export function mapHttpError(
  status: number,
  body: unknown,
  headers: HeaderGetter = NO_HEADERS,
): AppError {
  const envelope: ErrorResponse["error"] | null = isErrorResponse(body) ? body.error : null;
  const code = envelope?.code ?? "UNKNOWN";
  const requestId = envelope?.requestId ?? null;

  switch (status) {
    case 401:
      return { kind: "Unauthorized", reAuth: true };
    case 403:
      return { kind: "Forbidden", code };
    case 400:
      return { kind: "Validation", fields: extractFields(envelope?.details) };
    case 409:
      return { kind: "Conflict", serverVersion: serverVersionFromDetails(envelope?.details) };
    case 429: {
      const fromHeader = Number(headers("Retry-After"));
      const retryAfterSec =
        retryAfterFromDetails(envelope?.details) ??
        (Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 1);
      return { kind: "RateLimited", retryAfterSec };
    }
    default:
      // 5xx, 404/412/413, and any unknown code -> Server (open-ended, §6).
      return { kind: "Server", code, requestId };
  }
}

/** Map a transport failure (offline / timeout / DNS) to AppError.Network. */
export function mapNetworkError(cause: unknown): AppError {
  const name = cause instanceof Error ? cause.name : "";
  const retryable = name === "AbortError" || name === "TimeoutError" || name === "TypeError";
  return { kind: "Network", retryable };
}

/** True if the error warrants a single silent refresh+retry (AuthInterceptor). */
export function isReauthable(err: AppError): boolean {
  return err.kind === "Unauthorized" && err.reAuth;
}

/** Thrown carrier for an AppError across the client boundary. */
export class AppErrorException extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(`${appError.kind}`);
    this.name = "AppErrorException";
    this.appError = appError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAppErrorException(v: unknown): v is AppErrorException {
  return v instanceof AppErrorException;
}
