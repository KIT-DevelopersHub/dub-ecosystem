import { describe, it, expect } from "vitest";
import { mapError, fieldErrorMap } from "../src/domain/error-mapping";
import { taskCapabilities } from "../src/domain/permissions";
import type { DisplayableError } from "../src/contracts/spa-shell";

const de = (code: string, details?: unknown): DisplayableError => ({
  code, message: code, status: 400, retryable: false, ...(details !== undefined ? { details } : {}),
});

describe("error-mapping (design test 11)", () => {
  it("maps version conflict to rollback+refetch", () => {
    expect(mapError(de("TASK_VERSION_CONFLICT")).action).toBe("rollback_refetch");
    expect(mapError(de("CONFLICT")).action).toBe("rollback_refetch");
  });
  it("maps invalid transition to board rollback", () => {
    expect(mapError(de("TASK_INVALID_STATUS_TRANSITION")).action).toBe("rollback_transition");
  });
  it("maps forbidden to readonly fallback", () => {
    expect(mapError(de("FORBIDDEN")).action).toBe("readonly_fallback");
  });
  it("maps gantt cycle to banner and validation to field errors", () => {
    expect(mapError(de("GANTT_DEPENDENCY_CYCLE")).action).toBe("gantt_cycle_banner");
    expect(mapError(de("VALIDATION_FAILED")).action).toBe("field_errors");
  });
  it("upstream 5xx -> retry button", () => {
    expect(mapError(de("UPSTREAM_UNAVAILABLE")).action).toBe("retry_button");
  });
  it("transport failures map to a Japanese reason, never the raw English message", () => {
    // The api-client mints code=NETWORK_ERROR message='Failed to fetch' when the fetch
    // itself rejects. A bar move/resize hitting this must show a human reason (and roll
    // back), NOT leak 'Failed to fetch' to the toast.
    const net = mapError(de("NETWORK_ERROR", undefined));
    expect(net.action).toBe("retry_button");
    expect(net.message).toContain("ネットワーク");
    expect(mapError({ code: "NETWORK_ERROR", message: "Failed to fetch", status: 0, retryable: true }).message)
      .not.toMatch(/Failed to fetch/);
    expect(mapError(de("INTERNAL")).action).toBe("retry_button");
    expect(mapError({ code: "SOME_UNKNOWN_CODE", message: "boom raw english", status: 500, retryable: false }).message)
      .not.toMatch(/boom raw english/);
  });
  it("fieldErrorMap maps FieldError[] to {field:message}", () => {
    const m = fieldErrorMap([{ field: "title", reason: "required", message: "必須です" }, { field: "dueAt", reason: "invalid" }]);
    expect(m).toEqual({ title: "必須です", dueAt: "invalid" });
  });
});

describe("permissions gating (design test 10)", () => {
  it("null permissions = fail-closed (everything denied)", () => {
    expect(taskCapabilities(null)).toEqual({ canRead: false, canWrite: false, canDelete: false });
  });
  it("task:read only = view but no edit", () => {
    const caps = taskCapabilities(["task:read"]);
    expect(caps).toEqual({ canRead: true, canWrite: false, canDelete: false });
  });
  it("full task perms", () => {
    expect(taskCapabilities(["task:read", "task:write", "task:delete"])).toEqual({
      canRead: true, canWrite: true, canDelete: true,
    });
  });
});
