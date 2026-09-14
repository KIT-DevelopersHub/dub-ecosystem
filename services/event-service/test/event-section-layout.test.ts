import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";
import { fakeAuthz } from "./harness";
import type { EventRow } from "../src/types";

function seedEvent(deps: ReturnType<typeof makeDeps>, over: Partial<EventRow> = {}): string {
  const row: EventRow = {
    id: "event_layout_seed",
    orgId: "org_devhub",
    title: "Conf",
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

describe("event section layout store (shared D&D order/visibility)", () => {
  it("GET returns the default empty layout (version 0) before anything is saved", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const got = await call(app, "GET", `/events/${id}/section-layout`);
    expect(got.status).toBe(200);
    expect(got.json.eventId).toBe(id);
    expect(got.json.version).toBe(0);
    expect(got.json.updatedAt).toBeNull();
    expect(got.json.data).toEqual({ order: [], hidden: [] });
  });

  it("PUT creates (v0 -> v1), persists, and GET reads it back", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const body = { version: 0, data: { order: ["links", "contacts", "overview"], hidden: ["memo"] } };
    const saved = await call(app, "PUT", `/events/${id}/section-layout`, { body });
    expect(saved.status).toBe(200);
    expect(saved.json.version).toBe(1);
    expect(saved.json.data.order).toEqual(["links", "contacts", "overview"]);
    expect(saved.json.data.hidden).toEqual(["memo"]);

    const got = await call(app, "GET", `/events/${id}/section-layout`);
    expect(got.json.version).toBe(1);
    expect(got.json.data.order).toEqual(["links", "contacts", "overview"]);

    // audit recorded
    expect(deps.audit.records.map((r) => r.action)).toContain("event.event.section_layout_updated");
  });

  it("stale version PUT -> 409 EVENT_VERSION_CONFLICT", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    await call(app, "PUT", `/events/${id}/section-layout`, { body: { version: 0, data: { order: ["a"], hidden: [] } } });
    const conflict = await call(app, "PUT", `/events/${id}/section-layout`, {
      body: { version: 0, data: { order: ["b"], hidden: [] } },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("EVENT_VERSION_CONFLICT");
  });

  it("dedupes ids, drops empty strings, and caps at 100 entries", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const many = Array.from({ length: 150 }, (_, i) => `s${i}`);
    const body = { version: 0, data: { order: ["links", "", "links", ...many], hidden: [] } };
    const saved = await call(app, "PUT", `/events/${id}/section-layout`, { body });
    expect(saved.status).toBe(200);
    expect(saved.json.data.order[0]).toBe("links");
    expect(saved.json.data.order.filter((x: string) => x === "links")).toHaveLength(1);
    expect(saved.json.data.order).toHaveLength(100);
  });

  it("layout on an archived event is immutable (409)", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps, { archivedAt: "2026-08-02T00:00:00.000Z" });
    const app = createApp(deps);

    const res = await call(app, "PUT", `/events/${id}/section-layout`, { body: { version: 0, data: { order: [], hidden: [] } } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("EVENT_ARCHIVED_IMMUTABLE");
  });

  it("unknown / cross-org event -> 404", async () => {
    const deps = makeDeps();
    seedEvent(deps, { id: "event_other_org_layout", orgId: "org_other" });
    const app = createApp(deps);

    expect((await call(app, "GET", `/events/event_missing/section-layout`)).status).toBe(404);
    expect((await call(app, "GET", `/events/event_other_org_layout/section-layout`)).status).toBe(404);
  });

  it("write requires event:write permission (403 for read-only caller)", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read"])) });
    const id = seedEvent(deps);
    const app = createApp(deps);

    const res = await call(app, "PUT", `/events/${id}/section-layout`, { body: { version: 0, data: { order: [], hidden: [] } } });
    expect(res.status).toBe(403);
  });

  it("read-only caller can still GET the layout", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read"])) });
    const id = seedEvent(deps);
    const app = createApp(deps);

    const res = await call(app, "GET", `/events/${id}/section-layout`);
    expect(res.status).toBe(200);
  });
});
