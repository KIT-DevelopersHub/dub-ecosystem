import { describe, it, expect } from "vitest";
import { classifyError, isVersionConflict, fieldErrorsOf, normalizeError, EventErrorCodes } from "../src/lib/errorMap";
import { DubError, isDubError } from "@dub/errors";

function de(code: string, extra: { message?: string; details?: unknown } = {}): DubError {
  return new DubError(code, extra.message ?? code, { details: extra.details });
}

// Faithful stand-in for the FE2 real ApiClient's `ApiError` (apps/fe2-app-shell
// src/lib/api-client.tsx): an Error subclass carrying .code/.status/.details but
// deliberately NOT a DubError. FE3 cannot import fe2-app-shell cross-PR, so this
// mirrors the frozen shape. This is the exact value createHttpEventApi rejects
// with on the REAL wired path (the mock EventApi throws DubError instead — the
// gap this regression guards against, since bare wrapUnknown would collapse this
// to INTERNAL and silently kill every EVENT_* classification).
class ApiErrorLike extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

describe("classifyError (test observations #5, #7, #10, #11)", () => {
  it("maps common + event codes to handlings", () => {
    expect(classifyError("UNAUTHENTICATED")).toBe("reauth");
    expect(classifyError("AUTH_SESSION_EXPIRED")).toBe("reauth");
    expect(classifyError("FORBIDDEN")).toBe("forbidden-readonly");
    expect(classifyError("NOT_FOUND")).toBe("not-found");
    expect(classifyError("VALIDATION_FAILED")).toBe("form-field");
    expect(classifyError(EventErrorCodes.SLUG_CONFLICT)).toBe("form-field");
    expect(classifyError(EventErrorCodes.INVALID_PHASE_TRANSITION)).toBe("phase-error");
    expect(classifyError(EventErrorCodes.ARCHIVED_IMMUTABLE)).toBe("archived-readonly");
    expect(classifyError(EventErrorCodes.VERSION_CONFLICT)).toBe("version-conflict");
    expect(classifyError("RATE_LIMITED")).toBe("rate-limited");
    expect(classifyError("SOMETHING_UNKNOWN")).toBe("retry-toast");
  });

  it("isVersionConflict detects the 409 code", () => {
    expect(isVersionConflict(de(EventErrorCodes.VERSION_CONFLICT))).toBe(true);
    expect(isVersionConflict(de("CONFLICT"))).toBe(true);
    expect(isVersionConflict(de("NOT_FOUND"))).toBe(false);
  });

  it("extracts field errors from VALIDATION_FAILED details", () => {
    const err = de("VALIDATION_FAILED", {
      details: [{ field: "title", reason: "required", message: "必須です" }],
    });
    expect(fieldErrorsOf(err)).toEqual({ title: "必須です" });
  });

  it("maps slug conflict onto the slug field", () => {
    expect(fieldErrorsOf(de(EventErrorCodes.SLUG_CONFLICT, { message: "重複" }))).toEqual({ slug: "重複" });
  });
});

// Regression for the REAL wired path: FE2's ApiClient rejects with ApiError, not
// DubError. normalizeError must recover the wire .code so classification survives.
// (Previously bare @dub/errors wrapUnknown collapsed all of these to INTERNAL.)
describe("normalizeError on FE2 ApiError (real wired path, not the DubError mock)", () => {
  it("recovers the wire code so version-conflict is still detected", () => {
    const apiErr = new ApiErrorLike(409, EventErrorCodes.VERSION_CONFLICT, "version conflict");
    // sanity: this is NOT a DubError — the exact condition wrapUnknown mishandles
    expect(isDubError(apiErr)).toBe(false);
    const norm = normalizeError(apiErr);
    expect(norm.code).toBe(EventErrorCodes.VERSION_CONFLICT);
    expect(isVersionConflict(norm)).toBe(true);
  });

  it("recovers common CONFLICT as version-conflict", () => {
    expect(isVersionConflict(normalizeError(new ApiErrorLike(409, "CONFLICT", "conflict")))).toBe(true);
  });

  it("recovers phase-transition code for PhaseTransitionControl", () => {
    const apiErr = new ApiErrorLike(400, EventErrorCodes.INVALID_PHASE_TRANSITION, "bad phase");
    expect(classifyError(normalizeError(apiErr).code)).toBe("phase-error");
    expect(normalizeError(apiErr).message).toBe("bad phase");
  });

  it("recovers VALIDATION_FAILED field details for form rendering", () => {
    const apiErr = new ApiErrorLike(400, "VALIDATION_FAILED", "invalid", [
      { field: "title", reason: "required", message: "必須です" },
    ]);
    expect(classifyError(normalizeError(apiErr).code)).toBe("form-field");
    expect(fieldErrorsOf(normalizeError(apiErr))).toEqual({ title: "必須です" });
  });

  it("recovers SLUG_CONFLICT onto the slug field", () => {
    const apiErr = new ApiErrorLike(409, EventErrorCodes.SLUG_CONFLICT, "重複");
    expect(classifyError(normalizeError(apiErr).code)).toBe("form-field");
    expect(fieldErrorsOf(normalizeError(apiErr))).toEqual({ slug: "重複" });
  });

  it("recovers ARCHIVED_IMMUTABLE for the archived read-only path", () => {
    const apiErr = new ApiErrorLike(409, EventErrorCodes.ARCHIVED_IMMUTABLE, "archived");
    expect(classifyError(normalizeError(apiErr).code)).toBe("archived-readonly");
  });

  it("passes DubError through unchanged", () => {
    const orig = de(EventErrorCodes.VERSION_CONFLICT);
    expect(normalizeError(orig)).toBe(orig);
  });

  it("falls back to INTERNAL for a code-less throw (plain Error / string)", () => {
    expect(normalizeError(new Error("boom")).code).toBe("INTERNAL");
    expect(normalizeError("boom").code).toBe("INTERNAL");
    expect(classifyError(normalizeError(new Error("boom")).code)).toBe("retry-toast");
  });
});
