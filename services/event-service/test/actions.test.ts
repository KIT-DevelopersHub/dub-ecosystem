import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

async function newEvent(app: ReturnType<typeof createApp>): Promise<string> {
  const r = await call(app, "POST", "/events", { body: { title: "Host" } });
  return r.json.id as string;
}

describe("action hierarchy (tests #2, #3, #11)", () => {
  it("action is created only under an existing event; unknown event -> 404", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/events/event_missing/actions", { body: { kind: "task_management", title: "Board" } });
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");
  });

  it("creating an action carries eventId + a new kind string is accepted (#11)", async () => {
    const app = createApp(makeDeps());
    const eventId = await newEvent(app);
    const res = await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "totally_new_kind", title: "LT track" } });
    expect(res.status).toBe(201);
    expect(res.json.eventId).toBe(eventId);
    expect(res.json.kind).toBe("totally_new_kind");
    expect(res.json.version).toBe(1);
  });

  it("action under an archived event -> 409 EVENT_ARCHIVED_IMMUTABLE (#3)", async () => {
    const app = createApp(makeDeps());
    const eventId = await newEvent(app);
    await call(app, "DELETE", `/events/${eventId}`);
    const res = await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "sponsor", title: "S" } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("EVENT_ARCHIVED_IMMUTABLE");
  });
});

describe("action sortOrder gap method (#12)", () => {
  it("auto-assigns increasing 1024-gap sort orders", async () => {
    const app = createApp(makeDeps());
    const eventId = await newEvent(app);
    const a = await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "1" } });
    const b = await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "2" } });
    expect(a.json.sortOrder).toBe(1024);
    expect(b.json.sortOrder).toBe(2048);
  });

  it("explicit sortOrder (midpoint insert) is honored and list stays ordered", async () => {
    const app = createApp(makeDeps());
    const eventId = await newEvent(app);
    await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "first", sortOrder: 1024 } });
    await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "third", sortOrder: 2048 } });
    await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "second", sortOrder: 1536 } });
    const list = await call(app, "GET", `/events/${eventId}/actions`);
    expect(list.json.items.map((x: any) => x.title)).toEqual(["first", "second", "third"]);
  });
});

describe("action cursor pagination keys by (sort_order, id)", () => {
  it("walks all actions in sort order with no gaps or duplicates", async () => {
    const app = createApp(makeDeps());
    const eventId = await newEvent(app);
    for (let i = 0; i < 5; i++) {
      await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: `a${i}` } });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const q: Record<string, string | number> = { limit: 2 };
      if (cursor) q.cursor = cursor;
      const page = await call(app, "GET", `/events/${eventId}/actions`, { query: q });
      for (const it of page.json.items) seen.push(it.title);
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(seen).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });
});

describe("action update / archive", () => {
  it("update bumps version + emits action.updated; archive emits action.archived", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const eventId = await newEvent(app);
    const created = await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "t" } });
    const id = created.json.id as string;

    deps.publisher.events = [];
    const upd = await call(app, "PATCH", `/actions/${id}`, { body: { version: 1, title: "t2" } });
    expect(upd.status).toBe(200);
    expect(upd.json.version).toBe(2);
    expect(deps.publisher.namesFor("action.updated")).toHaveLength(1);

    const del = await call(app, "DELETE", `/actions/${id}`);
    expect(del.status).toBe(204);
    expect(deps.publisher.namesFor("action.archived")).toHaveLength(1);

    // write after archive -> 409
    const after = await call(app, "PATCH", `/actions/${id}`, { body: { version: 3, title: "x" } });
    expect(after.status).toBe(409);
    expect(after.json.error.code).toBe("EVENT_ARCHIVED_IMMUTABLE");
  });

  it("stale version on action PATCH -> 409 EVENT_VERSION_CONFLICT", async () => {
    const app = createApp(makeDeps());
    const eventId = await newEvent(app);
    const created = await call(app, "POST", `/events/${eventId}/actions`, { body: { kind: "k", title: "t" } });
    const id = created.json.id as string;
    await call(app, "PATCH", `/actions/${id}`, { body: { version: 1, title: "a" } });
    const stale = await call(app, "PATCH", `/actions/${id}`, { body: { version: 1, title: "b" } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("EVENT_VERSION_CONFLICT");
  });

  it("GET /actions/:id of an unknown action -> 404", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/actions/action_missing");
    expect(res.status).toBe(404);
  });
});
