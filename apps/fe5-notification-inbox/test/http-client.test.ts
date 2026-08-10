import { describe, expect, it, vi } from "vitest";
import { createHttpApiClient, HttpApiError } from "../src/api/http-client";
import { isApiError } from "../src/contracts/fe2";

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function captureError(p: Promise<unknown>): Promise<HttpApiError> {
  try {
    await p;
  } catch (e) {
    return e as HttpApiError;
  }
  throw new Error("expected the request to reject");
}

describe("createHttpApiClient", () => {
  it("GET serialises query, injects auth + correlation id, and parses JSON", async () => {
    const captured: Captured[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return jsonResponse({ count: 5 });
    }) as unknown as typeof fetch;

    const client = createHttpApiClient({
      baseUrl: "https://gw.test",
      getAuthToken: () => "tok_123",
      correlationId: () => "corr_1",
      fetchImpl,
    });

    const res = await client.get<{ count: number }>("/api/v1/notifications/inbox", {
      unreadOnly: true,
      limit: 10,
      cursor: undefined, // dropped
    });

    expect(res).toEqual({ count: 5 });
    const { url, init } = captured[0]!;
    expect(url).toBe("https://gw.test/api/v1/notifications/inbox?unreadOnly=true&limit=10");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok_123");
    expect(headers["x-dub-request-id"]).toBe("corr_1");
    expect(headers["content-type"]).toBeUndefined(); // no body on GET
  });

  it("PATCH/POST send a JSON body with content-type", async () => {
    const captured: Captured[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const client = createHttpApiClient({ fetchImpl });
    await client.patch<void>("/api/v1/notifications/preferences", { entries: [] });

    const { url, init } = captured[0]!;
    expect(url).toBe("/api/v1/notifications/preferences");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ entries: [] }));
  });

  it("returns undefined for 204 / empty-body responses (mark-read)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    const client = createHttpApiClient({ fetchImpl });
    const res = await client.patch<void>("/api/v1/notifications/inbox/x/read");
    expect(res).toBeUndefined();
  });

  it("normalises a standard ErrorResponse body into an ApiError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "NOTIF_INBOX_ITEM_NOT_FOUND",
            message: "Inbox item not found: x",
            retryable: false,
            requestId: "req_srv_9",
          },
        },
        { status: 404 },
      ),
    ) as unknown as typeof fetch;

    const client = createHttpApiClient({ fetchImpl });
    const err = await captureError(client.patch<void>("/api/v1/notifications/inbox/x/read"));

    expect(err).toBeInstanceOf(HttpApiError);
    expect(isApiError(err)).toBe(true);
    expect(err.code).toBe("NOTIF_INBOX_ITEM_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("req_srv_9");
    expect(err.retryable).toBe(false);
  });

  it("falls back to a status-based code for non-standard error bodies", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ) as unknown as typeof fetch;

    const client = createHttpApiClient({ fetchImpl });
    const err = await captureError(client.get("/api/v1/notifications/inbox"));
    expect(err.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
  });

  it("wraps transport failures as a retryable UPSTREAM_UNAVAILABLE (status 0)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const client = createHttpApiClient({ fetchImpl });
    const err = await captureError(client.get("/api/v1/notifications/inbox/unread-count"));
    expect(err).toBeInstanceOf(HttpApiError);
    expect(err.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
  });
});
