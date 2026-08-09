import { describe, it, expect, vi } from "vitest";
import type { ErrorResponse } from "@dub/errors";
import { createApiClient, ApiError, toDisplayableError } from "../src/index";

const BASE = "https://api.test";

function jsonRes(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

function errBody(code: string, message = "boom", requestId?: string): ErrorResponse {
  const error: ErrorResponse["error"] = { code, message, retryable: false };
  if (requestId) error.requestId = requestId;
  return { error };
}

const noSleep = async (): Promise<void> => {};

describe("createApiClient", () => {
  it("returns typed body on a normal GET and includes credentials", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    const res = await api.request<{ ok: boolean }>({ method: "GET", path: "/api/v1/me" });
    expect(res).toEqual({ ok: true });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.test/api/v1/me");
  });

  it("serializes query params on GET and omits undefined", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    await api.tasks.get("/", { status: "open", limit: 10, cursor: undefined });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.test/api/v1/tasks/?status=open&limit=10");
  });

  it("normalizes an ErrorResponse into ApiError and extracts requestId", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes(errBody("FORBIDDEN", "nope", "req-123"), 403));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    await expect(api.request({ method: "GET", path: "/api/v1/me" })).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      requestId: "req-123",
    });
    // correlationId alias mirrors requestId (design compat)
    try {
      await api.request({ method: "GET", path: "/api/v1/me" });
    } catch (e) {
      expect(ApiError.isApiError(e)).toBe(true);
      expect((e as ApiError).correlationId).toBe("req-123");
    }
  });

  it("reconstructs a non-envelope error body via @dub/errors fromResponse", async () => {
    // A 4xx with an unrecognized body -> UPSTREAM_UNAVAILABLE/502 (fromResponse rule);
    // requestId is recovered from the response header.
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonRes({ oops: "not an envelope" }, 400, { "x-dub-request-id": "hdr-req-1" }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    await expect(api.request({ method: "POST", path: "/api/v1/events", body: {} })).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
      requestId: "hdr-req-1",
    });
  });

  it("on 401 refreshes once (empty body) then retries and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(errBody("UNAUTHENTICATED"), 401))
      .mockResolvedValueOnce(jsonRes({ session: "new" }, 200)) // refresh
      .mockResolvedValueOnce(jsonRes({ ok: true }, 200)); // retry
    const onUnauthenticated = vi.fn();
    const api = createApiClient({ baseUrl: BASE, fetchImpl, onUnauthenticated });
    const res = await api.request<{ ok: boolean }>({ method: "GET", path: "/api/v1/me" });
    expect(res).toEqual({ ok: true });
    expect(onUnauthenticated).not.toHaveBeenCalled();
    const refreshCall = fetchImpl.mock.calls[1]!;
    expect(refreshCall[0]).toBe("https://api.test/api/v1/auth/refresh");
    expect((refreshCall[1] as RequestInit).method).toBe("POST");
    expect((refreshCall[1] as RequestInit).body).toBe("{}");
  });

  it("calls onUnauthenticated when refresh fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(errBody("UNAUTHENTICATED"), 401))
      .mockResolvedValueOnce(jsonRes(errBody("UNAUTHENTICATED"), 401)); // refresh fails
    const onUnauthenticated = vi.fn();
    const api = createApiClient({ baseUrl: BASE, fetchImpl, onUnauthenticated });
    await expect(api.request({ method: "GET", path: "/api/v1/me" })).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it("retries GET on 5xx up to maxRetries, then throws", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes(errBody("INTERNAL"), 500));
    const api = createApiClient({ baseUrl: BASE, fetchImpl, sleepImpl: noSleep, retry: { maxRetries: 2, baseDelayMs: 0 } });
    await expect(api.request({ method: "GET", path: "/api/v1/me" })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("does NOT retry write methods on 5xx", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes(errBody("INTERNAL"), 500));
    const api = createApiClient({ baseUrl: BASE, fetchImpl, sleepImpl: noSleep });
    await expect(api.request({ method: "POST", path: "/api/v1/events", body: {} })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("adds x-dub-request-id from the factory", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl, requestIdFactory: () => "rid-9" });
    await api.request({ method: "GET", path: "/api/v1/me" });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-dub-request-id"]).toBe("rid-9");
  });

  it("passes through caller headers (e.g. Cache-Control)", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    await api.request({ method: "GET", path: "/api/v1/gantt", headers: { "Cache-Control": "no-cache" } });
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("returns undefined on 204 No Content", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    const res = await api.tasks.delete<void>("/t1");
    expect(res).toBeUndefined();
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("retries GET on network error then wraps as NETWORK_ERROR ApiError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const api = createApiClient({ baseUrl: BASE, fetchImpl, sleepImpl: noSleep, retry: { maxRetries: 1, baseDelayMs: 0 } });
    await expect(api.request({ method: "GET", path: "/api/v1/me" })).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("auth.me / bff.home / resource clients hit the right paths", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    await api.auth.me();
    await api.bff.home();
    await api.events.get("/e1");
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "https://api.test/api/v1/me",
      "https://api.test/api/v1/bff/home",
      "https://api.test/api/v1/events/e1",
    ]);
  });

  it("list() returns a Paginated collection", async () => {
    const page = { items: [{ id: "n1" }, { id: "n2" }], nextCursor: "cur-2" };
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes(page));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    const res = await api.notifications.list<{ id: string }>("/", { limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe("cur-2");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.test/api/v1/notifications/?limit=2");
  });

  it("put() sends a JSON body with the PUT method", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const api = createApiClient({ baseUrl: BASE, fetchImpl });
    await api.identity.put<{ ok: boolean }, { role: string }>("/u1", { role: "admin" });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ role: "admin" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("toDisplayableError produces ja copy and carries requestId", () => {
    const e = new ApiError(403, errBody("FORBIDDEN", "x", "req-7"));
    const d = toDisplayableError(e);
    expect(d.code).toBe("FORBIDDEN");
    expect(d.description).toContain("権限");
    expect(d.requestId).toBe("req-7");
  });

  it("toDisplayableError falls back to the raw message for unknown codes", () => {
    const e = new ApiError(418, errBody("TASK_TEAPOT", "custom message"));
    const d = toDisplayableError(e);
    expect(d.code).toBe("TASK_TEAPOT");
    expect(d.description).toBe("custom message");
    expect(d.requestId).toBeUndefined();
  });
});
