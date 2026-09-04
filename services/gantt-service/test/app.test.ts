import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { createEvent } from "@dub/events";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import type { AppDeps, DtoCache, UpstreamPort } from "../src/ports";
import { fakeAuthClient, fakeUpstream, fakeViewRepo, fakeCache, fakeRealtime, mkTask } from "./helpers";
import type { FakeRealtime } from "./helpers";

const ENV = {} as Env;
const H = (extra: Record<string, string> = {}) => ({ "x-dub-request-id": "req_test", ...extra });
const AUTHED = H({ "x-dub-user-id": "user_a" });

function deps(over: {
  upstream?: UpstreamPort;
  cache?: DtoCache;
  allow?: boolean;
  views?: AppDeps["views"];
  realtime?: FakeRealtime;
}): AppDeps {
  const auth = fakeAuthClient({ allow: over.allow ?? true });
  const rt = over.realtime ?? fakeRealtime();
  return {
    upstream: () => over.upstream ?? fakeUpstream({}),
    cache: () => over.cache ?? fakeCache(),
    views: over.views ?? (() => fakeViewRepo()),
    authClient: () => auth,
    realtime: () => rt,
  };
}

describe("gantt-service HTTP", () => {
  it("GET /health -> 200 without auth", async () => {
    const res = await createApp(deps({})).request("/health", {}, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("GET /gantt without x-dub-user-id -> 401", async () => {
    const res = await createApp(deps({})).request("/gantt?eventId=event_1", { headers: H() }, ENV);
    expect(res.status).toBe(401);
  });

  it("GET /gantt when permission denied -> 403", async () => {
    const res = await createApp(deps({ allow: false })).request("/gantt?eventId=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(403);
  });

  it("GET /gantt without eventId -> 400", async () => {
    const res = await createApp(deps({})).request("/gantt", { headers: AUTHED }, ENV);
    expect(res.status).toBe(400);
  });

  it("GET /gantt reads ONLY the SoT key `eventId`; the drifted `?event=` alias is rejected", async () => {
    // The wire contract (gantt.GetGanttQuery) makes `eventId` the single query key. The
    // server must not read the old `?event=` alias — doing so is the exact drift the
    // wire-params contract test forbids. `?event=` therefore reads as "no eventId" -> 400.
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a" })] });
    const res = await createApp(deps({ upstream: up })).request("/gantt?event=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
  });

  it("GET /gantt for an unknown event -> 404 GANTT_EVENT_NOT_FOUND", async () => {
    const up = fakeUpstream({ eventExists: false });
    const res = await createApp(deps({ upstream: up })).request("/gantt?eventId=missing", { headers: AUTHED }, ENV);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("GANTT_EVENT_NOT_FOUND");
  });

  it("GET /gantt builds the DTO and writes the cache", async () => {
    const up = fakeUpstream({
      tasks: [mkTask({ id: "task_a", status: "done" }), mkTask({ id: "task_b" })],
      dependencies: [{ taskId: "task_b", dependsOnId: "task_a" }],
    });
    const cache = fakeCache();
    const res = await createApp(deps({ upstream: up, cache })).request("/gantt?eventId=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(200);
    const dto = (await res.json()) as gantt.GanttChartDTO;
    expect(dto.rows).toHaveLength(2);
    expect(dto.dependencies[0]).toMatchObject({ fromTaskId: "task_a", toTaskId: "task_b", type: "FS" });
    expect(cache.puts).toEqual(["event_1"]);
  });

  it("GET /gantt serves a cache hit without hitting upstream", async () => {
    const cache = fakeCache();
    await cache.put("event_1", { eventId: "event_1", rows: [], dependencies: [] });
    cache.puts.length = 0;
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a" })] });
    const res = await createApp(deps({ upstream: up, cache })).request("/gantt?eventId=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(200);
    expect(up.calls.listTasks).toBe(0); // never rebuilt
  });

  it("GET /gantt with Cache-Control: no-cache bypasses the cache", async () => {
    const cache = fakeCache();
    await cache.put("event_1", { eventId: "event_1", rows: [], dependencies: [] });
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a" })] });
    const res = await createApp(deps({ upstream: up, cache })).request(
      "/gantt?eventId=event_1",
      { headers: H({ "x-dub-user-id": "user_a", "cache-control": "no-cache" }) },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(up.calls.listTasks).toBe(1); // rebuilt despite cached value
  });

  it("GET /gantt/dependencies -> { eventId, dependencies }", async () => {
    const up = fakeUpstream({
      tasks: [mkTask({ id: "task_a" }), mkTask({ id: "task_b" })],
      dependencies: [{ taskId: "task_b", dependsOnId: "task_a" }],
    });
    const res = await createApp(deps({ upstream: up })).request("/gantt/dependencies?eventId=event_1", { headers: AUTHED }, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { eventId: string; dependencies: unknown[] };
    expect(body.eventId).toBe("event_1");
    expect(body.dependencies).toHaveLength(1);
  });

  it("GET/PUT /gantt/views round-trip for the owner", async () => {
    const views = fakeViewRepo();
    const app = createApp(deps({ views: () => views }));
    const g0 = await app.request("/gantt/views?eventId=event_1", { headers: AUTHED }, ENV);
    expect(await g0.json()).toEqual({ eventId: "event_1", zoom: "week", collapsedTaskIds: [] });

    const put = await app.request(
      "/gantt/views?eventId=event_1",
      { method: "PUT", headers: { ...AUTHED, "content-type": "application/json" }, body: JSON.stringify({ zoom: "day", collapsedTaskIds: ["task_a"] }) },
      ENV,
    );
    expect(put.status).toBe(200);
    const g1 = await app.request("/gantt/views?eventId=event_1", { headers: AUTHED }, ENV);
    expect(await g1.json()).toEqual({ eventId: "event_1", zoom: "day", collapsedTaskIds: ["task_a"] });
  });

  it("PUT /gantt/views with an invalid zoom -> 400", async () => {
    const res = await createApp(deps({})).request(
      "/gantt/views?eventId=event_1",
      { method: "PUT", headers: { ...AUTHED, "content-type": "application/json" }, body: JSON.stringify({ zoom: "year", collapsedTaskIds: [] }) },
      ENV,
    );
    expect(res.status).toBe(400);
  });
});

// Free-tier consumer landing route (replaces the dub-q-evt-gantt Queue consumer). No auth:
// gated only by x-dub-internal, which the gateway strips off external requests.
describe("gantt-service POST /internal/events-async (free-tier consumer)", () => {
  const ctx = { requestId: "req_test", actorId: "user_a" as string | null };
  const INTERNAL = { "content-type": "application/json", "x-dub-internal": "1" };
  const post = (app: ReturnType<typeof createApp>, headers: Record<string, string>, body: unknown) =>
    app.request("/internal/events-async", { method: "POST", headers, body: JSON.stringify(body) }, ENV);

  it("without x-dub-internal -> 404 (route never exposed externally)", async () => {
    const evt = createEvent("task.status_changed", { taskId: "task_a", eventId: "event_1", previousStatus: "todo", status: "done" }, ctx);
    const res = await post(createApp(deps({})), { "content-type": "application/json" }, evt);
    expect(res.status).toBe(404);
  });

  it("task.status_changed -> 202 and purges the DTO cache (same handler as the Queue path)", async () => {
    const cache = fakeCache();
    const evt = createEvent("task.status_changed", { taskId: "task_a", eventId: "event_1", previousStatus: "todo", status: "done" }, ctx);
    const res = await post(createApp(deps({ cache })), INTERNAL, evt);
    expect(res.status).toBe(202);
    expect(cache.purges).toEqual(["event_1"]);
  });

  it("event.archived -> purges cache AND reaps view-state rows", async () => {
    const cache = fakeCache();
    const views = fakeViewRepo();
    await views.put("user_a", "event_1", { zoom: "day", collapsedTaskIds: [] });
    const evt = createEvent("event.archived", { eventId: "event_1" }, ctx);
    const res = await post(createApp(deps({ cache, views: () => views })), INTERNAL, evt);
    expect(res.status).toBe(202);
    expect(cache.purges).toEqual(["event_1"]);
    expect((await views.get("user_a", "event_1")).zoom).toBe("week"); // reaped -> default
  });

  it("unknown event name -> 202 no-op (onUnknownEvent: ack parity)", async () => {
    const cache = fakeCache();
    const res = await post(createApp(deps({ cache })), INTERNAL, { id: "evt_x", name: "mail.sent", requestId: "req_test", payload: {} });
    expect(res.status).toBe(202);
    expect(cache.purges).toEqual([]);
  });

  it("malformed envelope (no name/id) -> 400", async () => {
    const res = await post(createApp(deps({})), INTERNAL, { foo: "bar" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /gantt/rows/:taskId (persist a bar window)", () => {
  const patch = (app: ReturnType<typeof createApp>, id: string, body: unknown, headers = AUTHED) =>
    app.request(`/gantt/rows/${id}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }, ENV);

  it("writes startsAt→startAt / endsAt→dueAt, purges the event cache, echoes the row", async () => {
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a", eventId: "event_1", title: "会場" })] });
    const cache = fakeCache();
    const res = await patch(createApp(deps({ upstream: up, cache })), "task_a", {
      startsAt: "2026-08-15T00:00:00.000Z",
      endsAt: "2026-08-18T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as gantt.GanttRow;
    expect(row.taskId).toBe("task_a");
    expect(row.startsAt).toBe("2026-08-15T00:00:00.000Z");
    expect(row.endsAt).toBe("2026-08-18T00:00:00.000Z");
    expect(up.calls.updateTaskDates).toBe(1);
    expect(cache.purges).toEqual(["event_1"]); // next read is fresh
  });

  it("requires auth (401 without x-dub-user-id) and does NOT need event:read scope", async () => {
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a" })] });
    const res401 = await patch(createApp(deps({ upstream: up })), "task_a", { startsAt: null, endsAt: null }, H());
    expect(res401.status).toBe(401);
    // event:read denied by the authz layer, but the row path is task-scoped → still 200
    // (task:write is enforced downstream in task-service, not here).
    const res200 = await patch(createApp(deps({ upstream: up, allow: false })), "task_a", { startsAt: null, endsAt: null });
    expect(res200.status).toBe(200);
  });

  it("400 on a non-ISO schedule value", async () => {
    const up = fakeUpstream({ tasks: [mkTask({ id: "task_a" })] });
    const res = await patch(createApp(deps({ upstream: up })), "task_a", { startsAt: "not-a-date", endsAt: null });
    expect(res.status).toBe(400);
    expect(up.calls.updateTaskDates).toBe(0);
  });

  it("404 for an unknown task (propagated from task-service)", async () => {
    const up = fakeUpstream({ tasks: [] });
    const res = await patch(createApp(deps({ upstream: up })), "task_missing", { startsAt: null, endsAt: null });
    expect(res.status).toBe(404);
  });
});
