import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";
import type { EventRow } from "../src/types";

function baseEventRow(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "event_seed",
    orgId: "org_devhub",
    title: "Seed",
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
}

describe("event CRUD lifecycle (test #1)", () => {
  it("create -> get -> update -> archive; archived writes are 409", async () => {
    const deps = makeDeps();
    const app = createApp(deps);

    // create
    const created = await call(app, "POST", "/events", { body: { title: "Conf 2026" } });
    expect(created.status).toBe(201);
    expect(created.json.phase).toBe("planning");
    expect(created.json.version).toBe(1);
    const id = created.json.id as string;

    // get (EventDetail with actions[])
    const got = await call(app, "GET", `/events/${id}`);
    expect(got.status).toBe(200);
    expect(got.json.id).toBe(id);
    expect(Array.isArray(got.json.actions)).toBe(true);

    // update (non-phase) bumps version + updatedAt
    const upd = await call(app, "PATCH", `/events/${id}`, { body: { version: 1, title: "Conf 2026 (rev)" } });
    expect(upd.status).toBe(200);
    expect(upd.json.title).toBe("Conf 2026 (rev)");
    expect(upd.json.version).toBe(2);

    // archive
    const del = await call(app, "DELETE", `/events/${id}`);
    expect(del.status).toBe(204);

    // write after archive -> 409 EVENT_ARCHIVED_IMMUTABLE
    const after = await call(app, "PATCH", `/events/${id}`, { body: { version: 3, title: "nope" } });
    expect(after.status).toBe(409);
    expect(after.json.error.code).toBe("EVENT_ARCHIVED_IMMUTABLE");
  });
});

describe("optimistic locking (test #8)", () => {
  it("stale version PATCH -> 409 EVENT_VERSION_CONFLICT", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "X" } });
    const id = created.json.id as string;
    // first update ok (version 1 -> 2)
    await call(app, "PATCH", `/events/${id}`, { body: { version: 1, title: "A" } });
    // second update with stale version 1 -> conflict
    const stale = await call(app, "PATCH", `/events/${id}`, { body: { version: 1, title: "B" } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("EVENT_VERSION_CONFLICT");
  });

  it("missing version -> 400 VALIDATION_FAILED", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "X" } });
    const id = created.json.id as string;
    const res = await call(app, "PATCH", `/events/${id}`, { body: { title: "no version" } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("org isolation (test #6)", () => {
  it("other-org event id -> 404 NOT_FOUND (existence hiding)", async () => {
    const deps = makeDeps();
    deps.repo.seedEvent(baseEventRow({ id: "event_foreign", orgId: "org_other" }));
    const app = createApp(deps);
    const res = await call(app, "GET", "/events/event_foreign");
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");
  });
});

describe("queue publish + audit (test #9)", () => {
  it("create emits exactly one event.created + one audit record", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await call(app, "POST", "/events", { body: { title: "Y" } });
    expect(deps.publisher.namesFor("event.created")).toHaveLength(1);
    expect(deps.publisher.events[0]?.actorId).toBe("user_caller");
    expect(deps.audit.records.filter((r) => r.action === "event.event.created")).toHaveLength(1);
  });

  it("pure phase change emits phase_changed only (not updated)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "Z" } });
    const id = created.json.id as string;
    deps.publisher.events = [];
    const upd = await call(app, "PATCH", `/events/${id}`, { body: { version: 1, phase: "preparing" } });
    expect(upd.status).toBe(200);
    expect(upd.json.phase).toBe("preparing");
    expect(deps.publisher.namesFor("event.phase_changed")).toHaveLength(1);
    expect(deps.publisher.namesFor("event.updated")).toHaveLength(0);
  });

  it("pure field update emits event.updated only", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "Z" } });
    const id = created.json.id as string;
    deps.publisher.events = [];
    await call(app, "PATCH", `/events/${id}`, { body: { version: 1, description: "hello" } });
    expect(deps.publisher.namesFor("event.updated")).toHaveLength(1);
    expect(deps.publisher.namesFor("event.phase_changed")).toHaveLength(0);
  });

  it("archive emits event.archived", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "Z" } });
    const id = created.json.id as string;
    deps.publisher.events = [];
    await call(app, "DELETE", `/events/${id}`);
    expect(deps.publisher.namesFor("event.archived")).toHaveLength(1);
  });
});

describe("validation", () => {
  it("empty title -> 400", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/events", { body: { title: "  " } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("health", () => {
  it("GET /health is open (no auth)", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/health", { userId: null });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
  });
});
