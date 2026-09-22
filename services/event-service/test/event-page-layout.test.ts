import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";
import { fakeAuthz } from "./harness";
import type { EventRow } from "../src/types";

function seedEvent(deps: ReturnType<typeof makeDeps>, over: Partial<EventRow> = {}): string {
  const row: EventRow = {
    id: "event_page_seed",
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

const doc = (blocks: unknown[]) => ({ version: 1, blocks, updatedAt: "2026-08-01T00:00:00.000Z" });
const textBlock = (id: string, text: string) => ({ id, type: "text", span: 4, content: { text } });

describe("event page layout store (free block-editor doc)", () => {
  it("GET returns the default empty doc (version 0) before anything is saved", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const got = await call(app, "GET", `/events/${id}/page-layout`);
    expect(got.status).toBe(200);
    expect(got.json.eventId).toBe(id);
    expect(got.json.version).toBe(0);
    expect(got.json.updatedAt).toBeNull();
    expect(got.json.data.blocks).toEqual([]);
  });

  it("PUT creates (v0 -> v1), persists opaque blocks, and GET reads them back", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const blocks = [textBlock("b1", "こんにちは"), textBlock("b2", "世界")];
    const saved = await call(app, "PUT", `/events/${id}/page-layout`, { body: { version: 0, data: doc(blocks) } });
    expect(saved.status).toBe(200);
    expect(saved.json.version).toBe(1);
    expect(saved.json.data.blocks).toEqual(blocks);

    const got = await call(app, "GET", `/events/${id}/page-layout`);
    expect(got.json.version).toBe(1);
    expect(got.json.data.blocks).toEqual(blocks);
    expect(got.json.updatedAt).not.toBeNull();

    expect(deps.audit.records.map((r) => r.action)).toContain("event.event.page_layout_updated");
  });

  it("second save (v1 -> v2) reflects an edited/added block — persistence across writes", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    await call(app, "PUT", `/events/${id}/page-layout`, { body: { version: 0, data: doc([textBlock("b1", "one")]) } });
    const two = await call(app, "PUT", `/events/${id}/page-layout`, {
      body: { version: 1, data: doc([textBlock("b1", "one-edited"), textBlock("b2", "two")]) },
    });
    expect(two.status).toBe(200);
    expect(two.json.version).toBe(2);
    expect(two.json.data.blocks).toHaveLength(2);

    const got = await call(app, "GET", `/events/${id}/page-layout`);
    expect(got.json.data.blocks[0].content.text).toBe("one-edited");
  });

  it("stale version PUT -> 409 EVENT_VERSION_CONFLICT", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    await call(app, "PUT", `/events/${id}/page-layout`, { body: { version: 0, data: doc([textBlock("b1", "a")]) } });
    const conflict = await call(app, "PUT", `/events/${id}/page-layout`, {
      body: { version: 0, data: doc([textBlock("b1", "b")]) },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("EVENT_VERSION_CONFLICT");
  });

  it("drops non-object blocks and caps the block count", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const many = Array.from({ length: 600 }, (_, i) => textBlock(`b${i}`, `t${i}`));
    const dirty = [null, 42, "x", ...many];
    const saved = await call(app, "PUT", `/events/${id}/page-layout`, {
      body: { version: 0, data: { version: 1, blocks: dirty, updatedAt: "" } },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.data.blocks).toHaveLength(500);
    expect(saved.json.data.blocks[0].id).toBe("b0");
  });

  it("page layout on an archived event is immutable (409)", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps, { archivedAt: "2026-08-02T00:00:00.000Z" });
    const app = createApp(deps);

    const res = await call(app, "PUT", `/events/${id}/page-layout`, { body: { version: 0, data: doc([]) } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("EVENT_ARCHIVED_IMMUTABLE");
  });

  it("unknown / cross-org event -> 404", async () => {
    const deps = makeDeps();
    seedEvent(deps, { id: "event_other_org_page", orgId: "org_other" });
    const app = createApp(deps);

    expect((await call(app, "GET", `/events/event_missing/page-layout`)).status).toBe(404);
    expect((await call(app, "GET", `/events/event_other_org_page/page-layout`)).status).toBe(404);
  });

  it("write requires event:write permission (403 for read-only caller)", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read"])) });
    const id = seedEvent(deps);
    const app = createApp(deps);

    const res = await call(app, "PUT", `/events/${id}/page-layout`, { body: { version: 0, data: doc([]) } });
    expect(res.status).toBe(403);
  });

  it("read-only caller can still GET the layout", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read"])) });
    const id = seedEvent(deps);
    const app = createApp(deps);

    const res = await call(app, "GET", `/events/${id}/page-layout`);
    expect(res.status).toBe(200);
  });
});
