// Map wire error codes to FE3 screen handling. Codes: common (@dub/errors
// CommonErrorCodes) + event-service specific EVENT_* (SCREAMING_SNAKE, theme3 D7).
import { CommonErrorCodes } from "@dub/errors";
import type { DisplayableError } from "../contracts/fe2";

// event-service specific codes (design §6). Kept local until event-service exports
// a code catalog; the string values are the frozen wire contract.
export const EventErrorCodes = {
  INVALID_PHASE_TRANSITION: "EVENT_INVALID_PHASE_TRANSITION", // 400
  SLUG_CONFLICT: "EVENT_SLUG_CONFLICT",
  ARCHIVED_IMMUTABLE: "EVENT_ARCHIVED_IMMUTABLE",
  VERSION_CONFLICT: "EVENT_VERSION_CONFLICT", // 409
} as const;

export type ErrorHandling =
  | "reauth" // UNAUTHENTICATED -> FE2 auth guard
  | "forbidden-readonly" // FORBIDDEN -> toast + read-only
  | "not-found" // NOT_FOUND -> 404 screen / rollback
  | "form-field" // VALIDATION_FAILED / SLUG_CONFLICT -> field error
  | "phase-error" // EVENT_INVALID_PHASE_TRANSITION -> control error
  | "archived-readonly" // EVENT_ARCHIVED_IMMUTABLE -> toast + read-only
  | "version-conflict" // rollback + refetch + diff
  | "rate-limited"
  | "retry-toast"; // INTERNAL / network -> rollback + retry toast

export function classifyError(code: string): ErrorHandling {
  switch (code) {
    case CommonErrorCodes.UNAUTHENTICATED:
    case "AUTH_INVALID_TOKEN":
    case "AUTH_SESSION_EXPIRED":
    case "AUTH_SESSION_REVOKED":
      return "reauth";
    case CommonErrorCodes.FORBIDDEN:
      return "forbidden-readonly";
    case CommonErrorCodes.NOT_FOUND:
      return "not-found";
    case CommonErrorCodes.VALIDATION_FAILED:
    case EventErrorCodes.SLUG_CONFLICT:
      return "form-field";
    case EventErrorCodes.INVALID_PHASE_TRANSITION:
      return "phase-error";
    case EventErrorCodes.ARCHIVED_IMMUTABLE:
      return "archived-readonly";
    case EventErrorCodes.VERSION_CONFLICT:
    case CommonErrorCodes.CONFLICT:
      return "version-conflict";
    case CommonErrorCodes.RATE_LIMITED:
      return "rate-limited";
    default:
      return "retry-toast";
  }
}

export function isVersionConflict(err: DisplayableError): boolean {
  return classifyError(err.code) === "version-conflict";
}

/** Field errors extracted from a VALIDATION_FAILED details payload (FieldError[]). */
export function fieldErrorsOf(err: DisplayableError): Record<string, string> {
  const out: Record<string, string> = {};
  if (err.code === EventErrorCodes.SLUG_CONFLICT) {
    out.slug = err.message;
    return out;
  }
  const details = err.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && typeof d === "object" && "field" in d) {
        const fe = d as { field: string; message?: string; reason?: string };
        out[fe.field] = fe.message ?? fe.reason ?? "invalid";
      }
    }
  }
  return out;
}
