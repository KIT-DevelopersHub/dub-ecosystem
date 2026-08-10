import { describe, it, expect, vi } from "vitest";
import { isErrorResponse, type ErrorResponse } from "@dub/errors";
import { createHttpClient } from "../src/api/httpClient";
import { createRosterApi } from "../src/api/rosterApi";
import { DEFAULT_USER_FILTERS } from "../src/lib/listUsersQuery";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fetch double that records the last call and returns a scripted Response. */
function fakeFetch(res: Response | ((url: string, init: RequestInit) => Response)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return typeof res === "function" ? res(u, init ?? {}) : res;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("createHttpClient — transport", () => {
  it("GET: builds query (omitting null/undefined), sends credentials + accept", async () => {
    const { fn, calls } = fakeFetch(jsonResponse({ items: [], nextCursor: null }));
    const client = createHttpClient({ baseUrl: "http://gw", fetchFn: fn });

    await client.get("/api/v1/identity/users", { q: "al", status: "active", roleKey: undefined, x: null });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toContain("http://gw/api/v1/identity/users?");
    expect(url).toContain("q=al");
    expect(url).toContain("status=active");
    expect(url).not.toContain("roleKey");
    expect(url).not.toContain("x=");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
    // GET carries no body / content-type.
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("GET: no query params -> no trailing '?'", async () => {
    const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
    await createHttpClient({ fetchFn: fn }).get("/api/v1/identity/roles");
    expect(calls[0]!.url).toBe("/api/v1/identity/roles");
  });

  it("GET: returns the parsed JSON body", async () => {
    const { fn } = fakeFetch(jsonResponse({ items: [{ id: "u1" }], nextCursor: null }));
    const out = await createHttpClient({ fetchFn: fn }).get<{ items: { id: string }[] }>("/api/v1/x");
    expect(out.items[0]!.id).toBe("u1");
  });

  it("POST: serializes JSON body and sets content-type", async () => {
    const { fn, calls } = fakeFetch(jsonResponse({ id: "role_new" }, { status: 201 }));
    await createHttpClient({ fetchFn: fn }).post("/api/v1/identity/roles", { name: "lead" });
    const { init } = calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "lead" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("merges extra headers and honours a custom credentials policy", async () => {
    const { fn, calls } = fakeFetch(jsonResponse({ ok: true }));
    const client = createHttpClient({
      fetchFn: fn,
      headers: { "x-dub-request-id": "req_42" },
      credentials: "same-origin",
    });
    await client.get("/api/v1/me");
    const { init } = calls[0]!;
    expect((init.headers as Record<string, string>)["x-dub-request-id"]).toBe("req_42");
    expect(init.credentials).toBe("same-origin");
  });

  it("non-2xx with a wire ErrorResponse body rejects with that same typed error", async () => {
    const wire: ErrorResponse = {
      error: { code: "CONFLICT", message: "role name exists", retryable: false },
    };
    const { fn } = fakeFetch(jsonResponse(wire, { status: 409 }));
    await expect(createHttpClient({ fetchFn: fn }).post("/api/v1/identity/roles", {})).rejects.toSatisfy(
      (e: unknown) => isErrorResponse(e) && (e as ErrorResponse).error.code === "CONFLICT",
    );
  });

  it("non-2xx with an opaque (non-wire) body synthesizes a code from the status", async () => {
    const { fn } = fakeFetch(new Response("<html>Not Found</html>", { status: 404, statusText: "Not Found" }));
    await expect(createHttpClient({ fetchFn: fn }).get("/api/v1/identity/users/nope")).rejects.toSatisfy(
      (e: unknown) => isErrorResponse(e) && (e as ErrorResponse).error.code === "NOT_FOUND",
    );
  });

  it("5xx opaque body -> retryable UPSTREAM_UNAVAILABLE", async () => {
    const { fn } = fakeFetch(new Response("boom", { status: 502, statusText: "Bad Gateway" }));
    await expect(createHttpClient({ fetchFn: fn }).get("/api/v1/x")).rejects.toSatisfy(
      (e: unknown) =>
        isErrorResponse(e) &&
        (e as ErrorResponse).error.code === "UPSTREAM_UNAVAILABLE" &&
        (e as ErrorResponse).error.retryable === true,
    );
  });

  it("DELETE: 204 empty body resolves void", async () => {
    const { fn, calls } = fakeFetch(new Response(null, { status: 204 }));
    await expect(createHttpClient({ fetchFn: fn }).delete("/api/v1/identity/roles/role_x")).resolves.toBeUndefined();
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("network failure (fetch throws) rejects with retryable UPSTREAM_UNAVAILABLE", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(createHttpClient({ fetchFn: fn }).get("/api/v1/x")).rejects.toSatisfy(
      (e: unknown) =>
        isErrorResponse(e) &&
        (e as ErrorResponse).error.code === "UPSTREAM_UNAVAILABLE" &&
        (e as ErrorResponse).error.retryable === true,
    );
  });

  it("falls back to globalThis.fetch when no fetchFn is passed", () => {
    // globalThis.fetch exists under jsdom/node, so construction succeeds; the eager
    // guard only throws in a host with no fetch at all.
    expect(() => createHttpClient({ baseUrl: "" })).not.toThrow();
  });
});

describe("createRosterApi over the http client — end to end", () => {
  it("listUsers threads filters through the URL and parses the page", async () => {
    const { fn, calls } = fakeFetch(
      jsonResponse({ items: [{ id: "user_bob", status: "active" }], nextCursor: null }),
    );
    const api = createRosterApi(createHttpClient({ baseUrl: "http://gw", fetchFn: fn }));
    const page = await api.listUsers({ ...DEFAULT_USER_FILTERS, search: "bob", status: "active" });

    expect(page.items[0]!.id).toBe("user_bob");
    expect(calls[0]!.url).toContain("/api/v1/identity/users?");
    expect(calls[0]!.url).toContain("q=bob");
    expect(calls[0]!.url).toContain("status=active");
  });

  it("propagates a VALIDATION_FAILED wire error through inviteUser", async () => {
    const wire: ErrorResponse = {
      error: {
        code: "VALIDATION_FAILED",
        message: "invalid email",
        retryable: false,
        details: [{ field: "email", reason: "format" }],
      },
    };
    const { fn } = fakeFetch(jsonResponse(wire, { status: 400 }));
    const api = createRosterApi(createHttpClient({ fetchFn: fn }));
    await expect(api.inviteUser({ email: "bad" })).rejects.toSatisfy(
      (e: unknown) => isErrorResponse(e) && (e as ErrorResponse).error.code === "VALIDATION_FAILED",
    );
  });
});
