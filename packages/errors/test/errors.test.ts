import { describe, it, expect } from "vitest";
import {
  DubError,
  errors,
  isDubError,
  wrapUnknown,
  toErrorResponse,
  toResponse,
  fromResponse,
  isErrorResponse,
  isRetryable,
  STATUS_BY_CODE,
  CommonErrorCodes,
  dubErrorHandler,
} from "../src/index";

describe("@dub/errors", () => {
  it("round-trips DubError -> toResponse -> fromResponse (code/status/details preserved, cause dropped)", async () => {
    const original = new DubError("TASK_CYCLE_DETECTED", "cycle", { status: 422, details: { at: "t1" }, service: "task-service", cause: new Error("x") });
    const res = toResponse(original, { requestId: "req_1", redactInternal: false });
    expect(res.status).toBe(422);
    const body = await res.json();
    const restored = fromResponse(res.status, body);
    expect(restored.code).toBe("TASK_CYCLE_DETECTED");
    expect(restored.status).toBe(422);
    expect(restored.details).toEqual({ at: "t1" });
    expect(restored.service).toBe("task-service");
    expect((restored as { cause?: unknown }).cause).toBeUndefined();
  });

  it("wrapUnknown normalizes anything to INTERNAL/500/non-retryable", () => {
    for (const v of [new Error("boom"), "str", undefined, { a: 1 }]) {
      const de = wrapUnknown(v);
      expect(de.code).toBe("INTERNAL");
      expect(de.status).toBe(500);
      expect(de.retryable).toBe(false);
      expect(isDubError(de)).toBe(true);
    }
  });

  it("redacts 5xx by default and keeps 4xx", () => {
    const internal = toErrorResponse(errors.internal("db exploded"));
    expect(internal.error.message).toBe("Internal error");
    expect(internal.error.details).toBeUndefined();
    const notFound = toErrorResponse(errors.notFound("Task", "t1"));
    expect(notFound.error.message).toContain("Task");
    expect(notFound.error.details).toEqual({ resource: "Task", id: "t1" });
  });

  it("resolves status for every common code, defaults service codes to 500", () => {
    for (const code of Object.keys(STATUS_BY_CODE) as (keyof typeof STATUS_BY_CODE)[]) {
      expect(new DubError(code, "m").status).toBe(STATUS_BY_CODE[code]);
    }
    expect(new DubError("SOME_SERVICE_CODE", "m").status).toBe(500);
    expect(new DubError("MOBILE_SYNC_CURSOR_EXPIRED", "m", { status: 410 }).status).toBe(410);
  });

  it("default retryable = UPSTREAM_*/RATE_LIMITED only", () => {
    expect(isRetryable(errors.upstreamUnavailable("identity"))).toBe(true);
    expect(isRetryable(errors.upstreamTimeout("identity"))).toBe(true);
    expect(isRetryable(errors.rateLimited(3))).toBe(true);
    expect(isRetryable(errors.internal())).toBe(false);
    expect(isRetryable(new Error("x"))).toBe(false);
  });

  it("fromResponse normalizes non-ErrorResponse bodies to UPSTREAM_UNAVAILABLE", () => {
    expect(fromResponse(500, "<html>oops</html>").code).toBe("UPSTREAM_UNAVAILABLE");
    expect(fromResponse(503, null).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(isErrorResponse({ error: { code: "X", message: "m", retryable: false } })).toBe(true);
    expect(isErrorResponse({ nope: 1 })).toBe(false);
  });

  it("toResponse sets Retry-After for RATE_LIMITED", async () => {
    const res = toResponse(errors.rateLimited(7));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("dubErrorHandler formats an uncaught throw with requestId passthrough", async () => {
    const handler = dubErrorHandler({ service: "task-service" });
    const fakeCtx = { req: { header: (h: string) => (h === "x-dub-request-id" ? "req_9" : undefined) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: Response = await (handler as any)(errors.forbidden("no"), fakeCtx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; requestId?: string; service?: string } };
    expect(body.error.code).toBe(CommonErrorCodes.FORBIDDEN);
    expect(body.error.requestId).toBe("req_9");
    expect(body.error.service).toBe("task-service");
  });
});
