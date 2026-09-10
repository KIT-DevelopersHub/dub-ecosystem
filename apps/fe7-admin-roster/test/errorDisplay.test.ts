import { describe, it, expect } from "vitest";
import { CommonErrorCodes, type ErrorResponse } from "@dub/errors";
import { presentError, fieldErrorMap, toErrorResponse } from "../src/lib/errorDisplay";

function er(code: string, details?: unknown): ErrorResponse {
  return { error: { code, message: `msg:${code}`, retryable: false, ...(details !== undefined ? { details } : {}) } };
}

// Mirrors @dub/api-client's ApiError: an Error subclass with flat code/message/
// retryable/body fields and NO top-level `.error` — the FE2-injected transport.
class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly body: ErrorResponse;
  constructor(status: number, body: ErrorResponse) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error.code;
    this.retryable = body.error.retryable;
    this.body = body;
  }
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

  it("unwraps an ApiError (FE2-injected transport) instead of collapsing to generic", () => {
    // Regression: ApiError has no top-level `.error`, so isErrorResponse missed it
    // and every failure showed the generic line. It must classify like the envelope.
    expect(presentError(new ApiError(403, er(CommonErrorCodes.FORBIDDEN)))).toMatchObject({ kind: "forbidden" });
    const v = presentError(new ApiError(400, er(CommonErrorCodes.VALIDATION_FAILED, [{ field: "email", reason: "format" }])));
    expect(v.kind).toBe("field-errors");
  });

  it("differentiates 未設定 / 上流 / 一時 for mail-gateway email-routing failures", () => {
    // 未設定: not user-retryable
    const unconfigured = presentError(new ApiError(503, er("MAIL_EMAIL_ROUTING_UNCONFIGURED")));
    expect(unconfigured).toMatchObject({ kind: "retry", retryable: false });
    expect(unconfigured.kind === "retry" && unconfigured.message).toContain("未完了");
    // 上流: transient, retryable (both the mail code and the common upstream codes)
    const upstream = presentError(new ApiError(502, er("MAIL_EMAIL_ROUTING_UPSTREAM")));
    expect(upstream).toMatchObject({ kind: "retry", retryable: true });
    expect(upstream.kind === "retry" && upstream.message).toContain("メール基盤");
    expect(presentError(er(CommonErrorCodes.UPSTREAM_TIMEOUT))).toMatchObject({ kind: "retry", retryable: true });
    // 一時: unknown service code surfaces the server message, retryable per envelope
    expect(presentError({ error: { code: "IDENTITY_X", message: "later", retryable: true } })).toMatchObject({
      kind: "retry",
      message: "later",
      retryable: true,
    });
  });
});

describe("toErrorResponse", () => {
  it("passes a bare envelope through", () => {
    const e = er(CommonErrorCodes.CONFLICT);
    expect(toErrorResponse(e)).toBe(e);
  });
  it("unwraps ApiError via .body", () => {
    const body = er(CommonErrorCodes.NOT_FOUND);
    expect(toErrorResponse(new ApiError(404, body))).toEqual(body);
  });
  it("reconstructs from flat code/message when .body is absent", () => {
    const flat = { code: "SOME_CODE", message: "boom", retryable: true, name: "ApiError" };
    expect(toErrorResponse(flat)).toEqual({ error: { code: "SOME_CODE", message: "boom", retryable: true } });
  });
  it("returns null for a plain Error / unknown value", () => {
    expect(toErrorResponse(new Error("x"))).toBeNull();
    expect(toErrorResponse("nope")).toBeNull();
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
