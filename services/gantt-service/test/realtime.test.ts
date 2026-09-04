import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { createEvent } from "@dub/events";
import { createApp } from "../src/app";
import { signWsTicket, verifyWsTicket, ticketExpiryMs, buildDoUrl, WS_TICKET_TTL_SEC } from "../src/wsticket";
import { NoopRealtimePublisher, buildRealtime } from "../src/realtime";
import type { Env } from "../src/env";
import type { AppDeps, DtoCache, UpstreamPort } from "../src/ports";
import { fakeAuthClient, fakeUpstream, fakeViewRepo, fakeCache, fakeRealtime, mkTask } from "./helpers";
import type { FakeRealtime } from "./helpers";

const ENV = {} as Env;
const H = (extra: Record<string, string> = {}) => ({ "x-dub-request-id": "req_test", ...extra });
const AUTHED = H({ "x-dub-user-id": "user_a" });
const SECRET = "test-secret";

function deps(over: {
  upstream?: UpstreamPort;
  cache?: DtoCache;
  allow?: boolean;
  realtime?: FakeRealtime;
}): AppDeps {
  const auth = fakeAuthClient({ allow: over.allow ?? true });
  const rt = over.realtime ?? fakeRealtime();
  return {
    upstream: () => over.upstream ?? fakeUpstream({}),
    cache: () => over.cache ?? fakeCache(),
    views: () => fakeViewRepo(),
    authClient: () => auth,
    realtime: () => rt,
  };
}

describe("ws-ticket (HMAC)", () => {
  it("signs then verifies its own claims", async () => {
    const exp = ticketExpiryMs();
    const ticket = await signWsTicket(SECRET, { eventId: "event_1", userId: "user_a", expEpochMs: exp });
    const claims = await verifyWsTicket(SECRET, ticket);
    expect(claims).toMatchObject({ eventId: "event_1", userId: "user_a" });
  });

  it("rejects a wrong secret", async () => {
    const ticket = await signWsTicket(SECRET, { eventId: "event_1", userId: "user_a", expEpochMs: ticketExpiryMs() });
    expect(await verifyWsTicket("other-secret", ticket)).toBeNull();
  });

  it("rejects an expired ticket", async () => {
    const ticket = await signWsTicket(SECRET, { eventId: "event_1", userId: "user_a", expEpochMs: Date.now() - 1 });
    expect(await verifyWsTicket(SECRET, ticket)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const ticket = await signWsTicket(SECRET, { eventId: "event_1", userId: "user_a", expEpochMs: ticketExpiryMs() });
    const [, sig] = ticket.split(".");
    const forged = `${btoa(JSON.stringify({ eventId: "event_evil", userId: "user_a", expEpochMs: ticketExpiryMs() }))}.${sig}`;
    expect(await verifyWsTicket(SECRET, forged)).toBeNull();
  });

  it("TTL is 60s and buildDoUrl substitutes :id", () => {
    expect(WS_TICKET_TTL_SEC).toBe(60);
    expect(buildDoUrl("wss://x/ws/:id", "event_1")).toBe("wss://x/ws/event_1");
    expect(buildDoUrl("wss://x/ws", "event_1")).toBe("wss://x/ws/event_1");
  });
});

describe("GET /gantt/ws-ticket", () => {
  it("requires auth (401 without user)", async () => {
    const res = await createApp(deps({})).request("/gantt/ws-ticket?eventId=event_1", { headers: H() }, ENV);
    expect(res.status).toBe(401);
  });

  it("403 when event:read is denied", async () => {
    const res = await createApp(deps({ allow: false })).request("/gantt/ws-ticket?eventId=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(403);
  });

  it("issues a verifiable ticket + doUrl for an authorized viewer", async () => {
    const env = { WS_TICKET_SECRET: SECRET, GANTT_RT_DO_URL_BASE: "wss://rt/ws/:id" } as Env;
    const res = await createApp(deps({})).request("/gantt/ws-ticket?eventId=event_1", { headers: AUTHED }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gantt.GanttWsTicketResponse;
    expect(body.doUrl).toBe("wss://rt/ws/event_1");
    const claims = await verifyWsTicket(SECRET, body.ticket);
    expect(claims).toMatchObject({ eventId: "event_1", userId: "user_a" });
  });
});

describe("realtime fanout from write paths", () => {
  it("PATCH /gantt/rows broadcasts a row.moved delta", async () => {
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a", eventId: "event_1" })] });
    const rt = fakeRealtime();
    const res = await createApp(deps({ upstream: up, realtime: rt })).request(
      "/gantt/rows/task_a",
      {
        method: "PATCH",
        headers: { ...AUTHED, "content-type": "application/json" },
        body: JSON.stringify({ startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-05T00:00:00Z" }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(rt.moved).toEqual([
      { eventId: "event_1", taskId: "task_a", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-05T00:00:00Z" },
    ]);
    expect(rt.invalidated).toEqual([]);
  });

  it("POST /internal/events-async broadcasts chart.invalidated with the trigger name", async () => {
    const rt = fakeRealtime();
    const evt = createEvent(
      "task.created",
      { taskId: "task_a", eventId: "event_1" },
      { requestId: "req_test", actorId: "user_a" },
    );
    const res = await createApp(deps({ realtime: rt })).request(
      "/internal/events-async",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-dub-internal": "1" },
        body: JSON.stringify(evt),
      },
      ENV,
    );
    expect(res.status).toBe(202);
    expect(rt.invalidated).toEqual([{ eventId: "event_1", reason: "task.created" }]);
  });

  it("buildRealtime returns a Noop when no GANTT_ROOM binding exists", async () => {
    const rt = buildRealtime(undefined);
    expect(rt).toBeInstanceOf(NoopRealtimePublisher);
    // Noop is a no-op (never throws, broadcasts nothing).
    await rt.publishRowMoved("event_1", { taskId: "task_a", startsAt: null, endsAt: null });
    await rt.publishInvalidated("event_1", "task.created");
  });
});
