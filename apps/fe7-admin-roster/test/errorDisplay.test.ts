import { describe, it, expect } from "vitest";
import { CommonErrorCodes, type ErrorResponse } from "@dub/errors";
import { presentError, fieldErrorMap } from "../src/lib/errorDisplay";

function er(code: string, details?: unknown): ErrorResponse {
  return { error: { code, message: `msg:${code}`, retryable: false, ...(details !== undefined ? { details } : {}) } };
}

describe("presentError", () => {
  it("maps UNAUTHENTICATED to reauth", () => {
    expect(presentError(er(CommonErrorCodes.UNAUTHENTICATED))).toEqual({ kind: "reauth" });
  });
  it("maps FORBIDDEN to forbidden with message", () => {
    expect(presentError(er(CommonErrorCodes.FORBIDDEN))).toMatchObject({ kind: "forbidden" });
  });
  it("maps NOT_FOUND to empty", () => {
    expect(presentError(er(CommonErrorCodes.NOT_FOUND))).toMatchObject({ kind: "empty" });
  });
  it("maps VALIDATION_FAILED with field errors extracted", () => {
    const p = presentError(er(CommonErrorCodes.VALIDATION_FAILED, [{ field: "email", reason: "format", message: "bad" }]));
    expect(p.kind).toBe("field-errors");
    if (p.kind === "field-errors") expect(p.fields[0]!.field).toBe("email");
  });
  it("maps CONFLICT to conflict", () => {
    expect(presentError(er(CommonErrorCodes.CONFLICT))).toMatchObject({ kind: "conflict" });
  });
  it("falls back to retry for unknown / network errors", () => {
    expect(presentError(new Error("network"))).toMatchObject({ kind: "retry", retryable: true });
    expect(presentError(er("IDENTITY_WHATEVER"))).toMatchObject({ kind: "retry" });
  });
});

describe("fieldErrorMap", () => {
  it("maps field -> message (or reason fallback)", () => {
    expect(fieldErrorMap([{ field: "email", reason: "format", message: "bad" }, { field: "name", reason: "required" }])).toEqual({
      email: "bad",
      name: "required",
    });
  });
});
