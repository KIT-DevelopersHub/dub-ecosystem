import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { toResponse, errors } from "@dub/errors";
import {
  DUB_HEADERS,
  extractContext,
  newRequestId,
  createServiceClient,
  DubHttpUnavailableError,
  type RequestContext,
} from "../src/index";

const ctx: RequestContext = { requestId: "req_abc", userId: "user_1" };

/** Fake Service Binding: scripted responses + captured requests. */
function fakeBinding(handler: (req: Request, callN: number) => Response | Promise<Response>) {
  const requests: Request[] = [];
  let n = 0;
  const fetcher = {
    fetch: async (req: Request) => {
      requests.push(req);
      return handler(req, ++n);
    },
  } as unknown as Fetcher;
  return { fetcher, requests };
}

describe("@dub/http context", () => {
  it("extractContext reads x-dub-* and rejects missing requestId", () => {
    const h = new Headers({ [DUB_HEADERS.requestId]: "req_1", [DUB_HEADERS.userId]: "u1", [DUB_HEADERS.caller]: "gateway" });
    expect(extractContext(h)).toEqual({ requestId: "req_1", userId: "u1", caller: "gateway" });
    expect(() => extractContext(new Headers())).toThrowError(/HTTP_CONTEXT_MISSING|absent/);
    const gen = extractContext(new Headers(), { allowGenerate: true });
    expect(gen.requestId.length).toBeGreaterThan(20);
  });

  it("newRequestId mints unique ULID-ish ids", () => {
    expect(new Set([newRequestId(), newRequestId(), newRequestId()]).size).toBe(3);
  });
});

describe("@dub/http client", () => {
  it("injects requestId/caller/internal(+userId) and never org/roles headers", async () => {
    const { fetcher, requests } = fakeBinding(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createServiceClient(fetcher, { service: "task-service", caller: "api-gateway" });
    const res = await client.get<{ ok: boolean }>(ctx, "/api/v1/tasks");
    expect(res.ok).toBe(true);
    const sent = requests[0]!;
    expect(sent.headers.get(DUB_HEADERS.requestId)).toBe("req_abc");
    expect(sent.headers.get(DUB_HEADERS.caller)).toBe("api-gateway");
    expect(sent.headers.get(DUB_HEADERS.internal)).toBe("1");
    expect(sent.headers.get(DUB_HEADERS.userId)).toBe("user_1");
    expect(sent.headers.get("x-dub-org-id")).toBeNull();
    expect(sent.headers.get("x-dub-roles")).toBeNull();
  });

  it("retries idempotent GET on 503 then succeeds", async () => {
    const { fetcher } = fakeBinding((_r, n) =>
      n < 3 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ v: 1 }), { status: 200 }),
    );
    const retries: number[] = [];
    const client = createServiceClient(fetcher, {
      service: "task-service",
      caller: "gw",
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
      hooks: { onRetry: (i) => retries.push(i.attempt) },
    });
    const out = await client.get<{ v: number }>(ctx, "/x");
    expect(out.v).toBe(1);
    expect(retries.length).toBe(2);
  });

  it("passes through upstream 4xx business errors (code transparent, not wrapped)", async () => {
    const { fetcher } = fakeBinding(() => toResponse(errors.forbidden("nope"), { requestId: "req_abc" }));
    const client = createServiceClient(fetcher, { service: "identity", caller: "gw" });
    await expect(client.get(ctx, "/authz")).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("does not retry POST without idempotencyKey (503 -> throw)", async () => {
    let calls = 0;
    const { fetcher } = fakeBinding(() => {
      calls++;
      return new Response("busy", { status: 503 });
    });
    const client = createServiceClient(fetcher, { service: "task-service", caller: "gw", retry: { baseDelayMs: 1 } });
    await expect(client.post(ctx, "/x", { a: 1 })).rejects.toBeInstanceOf(DubHttpUnavailableError);
    expect(calls).toBe(1);
  });

  it("retries POST when an idempotencyKey is supplied", async () => {
    let calls = 0;
    const { fetcher } = fakeBinding((_r, n) => {
      calls++;
      return n < 2 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    });
    const client = createServiceClient(fetcher, { service: "task-service", caller: "gw", retry: { baseDelayMs: 1 } });
    await client.post(ctx, "/x", { a: 1 }, { idempotencyKey: "idem_1" });
    expect(calls).toBe(2);
  });

  it("normalizes non-ErrorResponse upstream bodies to UPSTREAM_UNAVAILABLE", async () => {
    const { fetcher } = fakeBinding(() => new Response("<html>500</html>", { status: 500 }));
    const client = createServiceClient(fetcher, { service: "task-service", caller: "gw" });
    await expect(client.get(ctx, "/x", { retry: false })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});
