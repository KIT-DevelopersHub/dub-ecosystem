// #836 contract: what freeq-drain actually sends for `evt.gantt` must get past THIS worker's
// entry gate. The drain used to POST to "https://gantt-service/..."; the entry only lets
// service-binding traffic (host "svc") reach the header-trusting API, so every row 404'd and
// sat pending for weeks. Both sides now read SERVICE_BINDING_ORIGIN / isServiceBindingRequest
// from @dub/http; this test drives the drain's real makeDeliver into the real entry.
import { describe, it, expect, vi } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
// Isolate the ENTRY gate: the app behind it is covered by app.test.ts.
const appCalls: Request[] = [];
vi.mock("../src/app", () => ({
  createApp: () => ({
    fetch: (req: Request) => {
      appCalls.push(req);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    },
  }),
}));

const { default: handler } = await import("../src/index");
const { makeDeliver, routeFor } = await import("../../freeq-drain/src/routing");

function drainEnvRoutingTo(fetchImpl: (req: Request) => Promise<Response> | Response) {
  const SVC_GANTT = { fetch: (input: string, init: RequestInit) => fetchImpl(new Request(input, init)) } as unknown as Fetcher;
  return { SVC_GANTT } as never;
}

describe("freeq-drain -> gantt-service /internal/events-async (#836)", () => {
  it("evt.gantt is a delivering route to SVC_GANTT", () => {
    expect(routeFor("evt.gantt")).toMatchObject({ kind: "deliver", binding: "SVC_GANTT", path: "/internal/events-async" });
  });

  it("a drained evt.gantt envelope passes the entry gate (was 404)", async () => {
    appCalls.length = 0;
    const deliver = makeDeliver(
      drainEnvRoutingTo((req) => handler.fetch!(req as never, {} as never, {} as never) as unknown as Response),
    );
    const envelope = { name: "task.status_changed", version: 1, id: "evt_1", occurredAt: "2026-11-06T17:04:47.545Z", requestId: "r", actorId: null, payload: { taskId: "t", eventId: "e", previousStatus: "todo", status: "done" } };
    await expect(deliver({ topic: "evt.gantt", payload: envelope } as never)).resolves.toBeUndefined();
    expect(appCalls).toHaveLength(1);
    expect(new URL(appCalls[0]!.url).pathname).toBe("/internal/events-async");
  });

  it("a public workers.dev request to the same path is still refused", async () => {
    const res = (await handler.fetch!(
      new Request("https://dub-gantt-service.developershub-site.workers.dev/internal/events-async", { method: "POST", headers: { "x-dub-internal": "1" } }) as never,
      {} as never,
      {} as never,
    )) as unknown as Response;
    expect(res.status).toBe(404);
  });
});
