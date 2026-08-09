import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import type { AppDeps, DtoCache, UpstreamPort } from "../src/ports";
import { fakeAuthClient, fakeUpstream, fakeViewRepo, fakeCache, mkTask } from "./helpers";

const ENV = {} as Env;
const H = (extra: Record<string, string> = {}) => ({ "x-dub-request-id": "req_test", ...extra });
const AUTHED = H({ "x-dub-user-id": "user_a" });

function deps(over: {
  upstream?: UpstreamPort;
  cache?: DtoCache;
  allow?: boolean;
  views?: AppDeps["views"];
}): AppDeps {
  const auth = fakeAuthClient({ allow: over.allow ?? true });
  return {
    upstream: () => over.upstream ?? fakeUpstream({}),
    cache: () => over.cache ?? fakeCache(),
    views: over.views ?? (() => fakeViewRepo()),
    authClient: () => auth,
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
