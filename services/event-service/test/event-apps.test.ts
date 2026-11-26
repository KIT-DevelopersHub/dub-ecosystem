import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createDbClient } from "@dub/db";
import { makeD1 } from "./d1";
import { appRegistry } from "@dub/types";
import { makeDeps, call, createApp, fakeAuthz, VIEWER, FULL } from "./harness";
import type { EventRow } from "../src/types";

function seedLegacyEvent(deps: ReturnType<typeof makeDeps>, over: Partial<EventRow> = {}): string {
  const row: EventRow = {
    id: "event_legacy",
    orgId: "org_devhub",
    title: "北陸ITカンファレンス 2027",
    description: null,
    phase: "planning",
    startsAt: null,
    endsAt: null,
    archivedAt: null,
    version: 1,
    createdBy: "user_seed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
  deps.repo.seedEvent(row);
  return row.id;
}

describe("per-event enabled apps", () => {
  it("an existing (legacy) event keeps every app enabled — no backfill needed", async () => {
    const deps = makeDeps();
    const id = seedLegacyEvent(deps);
    const app = createApp(deps);

    const got = await call(app, "GET", `/events/${id}/apps`);
    expect(got.status).toBe(200);
    expect(got.json).toEqual({
      eventId: id,
      enabledApps: [...appRegistry.APP_IDS],
      customized: false,
      updatedAt: null,
    });
    const detail = await call(app, "GET", `/events/${id}`);
    expect(detail.json.enabledApps).toEqual([...appRegistry.APP_IDS]);
  });

  it("a NEW event starts with イベント・ガントチャート・ロール管理", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "miniconference" } });
    expect(created.status).toBe(201);
    const got = await call(app, "GET", `/events/${created.json.id}/apps`);
    expect(got.json.enabledApps).toEqual(["events", "gantt", "admin"]);
    expect(got.json.customized).toBe(true);
  });

  it("create accepts an explicit set and rejects an unknown id before writing", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const ok = await call(app, "POST", "/events", { body: { title: "x", enabledApps: ["members"] } });
    expect((await call(app, "GET", `/events/${ok.json.id}/apps`)).json.enabledApps).toEqual(["events", "members"]);

    const bad = await call(app, "POST", "/events", { body: { title: "y", enabledApps: ["nope"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION_FAILED");
  });

  it("PUT replaces the set (canonical order, イベント always on), audits before/after", async () => {
    const deps = makeDeps();
    const id = seedLegacyEvent(deps);
    const app = createApp(deps);

    const saved = await call(app, "PUT", `/events/${id}/apps`, { body: { enabledApps: ["members", "gantt"] } });
    expect(saved.status).toBe(200);
    expect(saved.json.enabledApps).toEqual(["events", "gantt", "members"]);
    expect(saved.json.customized).toBe(true);
    expect((await call(app, "GET", `/events/${id}`)).json.enabledApps).toEqual(["events", "gantt", "members"]);

    const rec = deps.audit.records.find((r) => r.action === "event.event.apps_updated");
    expect(rec?.details).toEqual({ before: [...appRegistry.APP_IDS], after: ["events", "gantt", "members"] });
  });

  it("PUT rejects an unknown app id (400) and leaves the setting untouched", async () => {
    const deps = makeDeps();
    const id = seedLegacyEvent(deps);
    const res = await call(createApp(deps), "PUT", `/events/${id}/apps`, { body: { enabledApps: ["bogus"] } });
    expect(res.status).toBe(400);
    expect(await deps.repo.getEventApps(id)).toBeNull();
  });

  it("a viewer can read but not change it", async () => {
    const deps = makeDeps({ ...fakeAuthz(VIEWER) });
    const id = seedLegacyEvent(deps);
    const app = createApp(deps);
    expect((await call(app, "GET", `/events/${id}/apps`)).status).toBe(200);
    expect((await call(app, "PUT", `/events/${id}/apps`, { body: { enabledApps: [] } })).status).toBe(403);
  });

  it("an event:write grant scoped to ANOTHER event cannot reconfigure this one", async () => {
    const deps = makeDeps({ ...fakeAuthz(FULL, { scopedTo: ["event_other"] }) });
    const id = seedLegacyEvent(deps);
    const res = await call(createApp(deps), "PUT", `/events/${id}/apps`, { body: { enabledApps: [] } });
    expect(res.status).toBe(403);
    expect(await deps.repo.getEventApps(id)).toBeNull();
  });

  it("an archived event is immutable", async () => {
    const deps = makeDeps();
    const id = seedLegacyEvent(deps, { archivedAt: "2026-09-01T00:00:00.000Z" });
    const res = await call(createApp(deps), "PUT", `/events/${id}/apps`, { body: { enabledApps: [] } });
    expect(res.status).toBe(409);
  });
});

describe("D1: migration 0007 + repo on real SQLite", () => {
  it("is re-runnable, reads null before any write, and upserts on the event_id key", async () => {
    const { d1, raw } = makeD1();
    for (const f of ["0001_init", "0005_event_venue_capacity", "0007_event_enabled_apps", "0007_event_enabled_apps"]) {
      raw.exec(readFileSync(new URL(`../../../infra/d1/migrations/event/${f}.sql`, import.meta.url), "utf8"));
    }
    const { createD1EventRepo } = await import("../src/d1-repo");
    const repo = createD1EventRepo(createDbClient(d1, { namespace: "event" }));
    await repo.createEvent({
      id: "event_1", orgId: "org_devhub", title: "t", description: null, phase: "planning",
      startsAt: null, endsAt: null, archivedAt: null, version: 1, createdBy: "u",
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(await repo.getEventApps("event_1")).toBeNull();
    await repo.putEventApps({ eventId: "event_1", apps: ["events", "gantt"], updatedBy: "u", updatedAt: "2026-08-02T00:00:00.000Z" });
    await repo.putEventApps({ eventId: "event_1", apps: ["events", "members"], updatedBy: "v", updatedAt: "2026-08-03T00:00:00.000Z" });
    expect(await repo.getEventApps("event_1")).toEqual({
      eventId: "event_1", apps: ["events", "members"], updatedBy: "v", updatedAt: "2026-08-03T00:00:00.000Z",
    });
  });
});

describe("OpenAPI drift guard", () => {
  it("the AppId enum in docs/openapi/event-service.yaml equals appRegistry.APP_IDS", () => {
    const yaml = readFileSync(new URL("../../../docs/openapi/event-service.yaml", import.meta.url), "utf8");
    const m = yaml.match(/AppId:\n(?:.*\n){0,3}?\s+enum: \[([^\]]+)\]/);
    expect(m, "AppId enum not found").not.toBeNull();
    expect(m![1]!.split(",").map((x) => x.trim())).toEqual([...appRegistry.APP_IDS]);
  });
});
