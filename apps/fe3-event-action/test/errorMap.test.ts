import { describe, it, expect } from "vitest";
import { classifyError, isVersionConflict, fieldErrorsOf, EventErrorCodes } from "../src/lib/errorMap";
import { DubError } from "@dub/errors";

function de(code: string, extra: { message?: string; details?: unknown } = {}): DubError {
  return new DubError(code, extra.message ?? code, { details: extra.details });
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
