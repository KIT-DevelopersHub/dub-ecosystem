import { describe, it, expect } from "vitest";
import { mapHttpError, mapNetworkError, isReauthable, type AppError } from "../src/errors";
import { errorBody } from "./helpers";

const noHeaders = () => null;

describe("mapHttpError — @dub/errors envelope -> AppError (§6)", () => {
  it("401 -> Unauthorized(reAuth)", () => {
    const e = mapHttpError(401, errorBody("AUTH_INVALID_TOKEN"), noHeaders);
    expect(e).toEqual({ kind: "Unauthorized", reAuth: true });
    expect(isReauthable(e)).toBe(true);
  });

  it("403 -> Forbidden(code)", () => {
    const e = mapHttpError(403, errorBody("FORBIDDEN"), noHeaders);
    expect(e).toEqual({ kind: "Forbidden", code: "FORBIDDEN" });
  });

  it("400 -> Validation(fields) from FieldError[]", () => {
    const body = errorBody("VALIDATION_FAILED", [
      { field: "title", reason: "required", message: "Title is required" },
      { field: "status", reason: "invalid" },
    ]);
    const e = mapHttpError(400, body, noHeaders);
    expect(e).toEqual({
      kind: "Validation",
      fields: { title: "Title is required", status: "invalid" },
    });
  });

  it("409 -> Conflict(serverVersion from details)", () => {
    const e = mapHttpError(409, errorBody("TASK_VERSION_CONFLICT", { serverVersion: 7 }), noHeaders);
    expect(e).toEqual({ kind: "Conflict", serverVersion: 7 });
  });

  it("409 without version detail -> Conflict(null)", () => {
    const e = mapHttpError(409, errorBody("CONFLICT"), noHeaders);
    expect(e).toEqual({ kind: "Conflict", serverVersion: null });
  });

  it("429 prefers details.retryAfterSec", () => {
    const e = mapHttpError(429, errorBody("RATE_LIMITED", { retryAfterSec: 12 }), noHeaders);
    expect(e).toEqual({ kind: "RateLimited", retryAfterSec: 12 });
  });

  it("429 falls back to Retry-After header", () => {
    const headers = (n: string) => (n === "Retry-After" ? "5" : null);
    const e = mapHttpError(429, errorBody("RATE_LIMITED"), headers);
    expect(e).toEqual({ kind: "RateLimited", retryAfterSec: 5 });
  });

  it("5xx -> Server(code, requestId)", () => {
    const e = mapHttpError(500, errorBody("INTERNAL", undefined, "req_abc"), noHeaders);
    expect(e).toEqual({ kind: "Server", code: "INTERNAL", requestId: "req_abc" });
  });

  it("unknown/unmapped status (404) -> Server (open-ended)", () => {
    const e = mapHttpError(404, errorBody("TASK_NOT_FOUND", undefined, "req_x"), noHeaders);
    expect(e).toEqual({ kind: "Server", code: "TASK_NOT_FOUND", requestId: "req_x" });
  });

  it("non-envelope body still resolves to Server with UNKNOWN code", () => {
    const e = mapHttpError(503, "<html>gateway</html>", noHeaders);
    expect(e).toEqual({ kind: "Server", code: "UNKNOWN", requestId: null });
  });
});

describe("mapNetworkError", () => {
  it("AbortError/TypeError -> Network(retryable)", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(mapNetworkError(abort)).toEqual({ kind: "Network", retryable: true });
  });
  it("other -> Network(non-retryable)", () => {
    const e = mapNetworkError(new Error("boom")) as Extract<AppError, { kind: "Network" }>;
    expect(e.kind).toBe("Network");
    expect(e.retryable).toBe(false);
  });
});
