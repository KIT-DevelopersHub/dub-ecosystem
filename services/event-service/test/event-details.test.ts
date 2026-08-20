import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";
import { fakeAuthz } from "./harness";
import type { EventRow } from "../src/types";

function seedEvent(deps: ReturnType<typeof makeDeps>, over: Partial<EventRow> = {}): string {
  const row: EventRow = {
    id: "event_details_seed",
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

describe("event details store (free-form)", () => {
  it("GET returns empty defaults (version 0) before anything is saved", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const got = await call(app, "GET", `/events/${id}/details`);
    expect(got.status).toBe(200);
    expect(got.json.eventId).toBe(id);
    expect(got.json.version).toBe(0);
    expect(got.json.updatedAt).toBeNull();
    expect(got.json.data).toEqual({ overview: "", memo: "", venue: "", links: [], contacts: [] });
  });

  it("PUT creates (v0 -> v1), persists, and GET reads it back", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const body = {
      version: 0,
      data: {
        overview: "年次カンファレンス",
        memo: "登壇者調整中",
        venue: "金沢商工会議所",
        links: [{ label: "アジェンダ", url: "https://example.com/agenda" }],
        contacts: [{ label: "事務局", value: "info@example.com" }],
      },
    };
    const saved = await call(app, "PUT", `/events/${id}/details`, { body });
    expect(saved.status).toBe(200);
    expect(saved.json.version).toBe(1);
    expect(saved.json.data.overview).toBe("年次カンファレンス");
    expect(saved.json.data.links).toHaveLength(1);

    const got = await call(app, "GET", `/events/${id}/details`);
    expect(got.json.version).toBe(1);
    expect(got.json.data.venue).toBe("金沢商工会議所");
    expect(got.json.data.contacts[0].value).toBe("info@example.com");

    // audit recorded
    expect(deps.audit.records.map((r) => r.action)).toContain("event.event.details_updated");
  });

  it("stale version PUT -> 409 EVENT_VERSION_CONFLICT", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    await call(app, "PUT", `/events/${id}/details`, { body: { version: 0, data: { memo: "a" } } });
    // second save must use version 1; sending 0 again conflicts
    const conflict = await call(app, "PUT", `/events/${id}/details`, { body: { version: 0, data: { memo: "b" } } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("EVENT_VERSION_CONFLICT");
  });

  it("blank/garbage entries are dropped and text is normalized", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const body = {
      version: 0,
      data: {
        overview: "ok",
        links: [
          { label: "", url: "" }, // dropped (both empty)
          { label: "資料", url: "https://x" },
        ],
      },
    };
    const saved = await call(app, "PUT", `/events/${id}/details`, { body });
    expect(saved.json.data.links).toHaveLength(1);
    expect(saved.json.data.links[0].label).toBe("資料");
    expect(saved.json.data.memo).toBe(""); // missing key -> default
  });

  it("details on an archived event are immutable (409)", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps, { archivedAt: "2026-08-02T00:00:00.000Z" });
    const app = createApp(deps);

    const res = await call(app, "PUT", `/events/${id}/details`, { body: { version: 0, data: { memo: "x" } } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("EVENT_ARCHIVED_IMMUTABLE");
  });

  it("unknown / cross-org event -> 404", async () => {
    const deps = makeDeps();
    seedEvent(deps, { id: "event_other_org", orgId: "org_other" });
    const app = createApp(deps);

    expect((await call(app, "GET", `/events/event_missing/details`)).status).toBe(404);
    expect((await call(app, "GET", `/events/event_other_org/details`)).status).toBe(404);
  });

  it("write requires event:write permission (403 for read-only caller)", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read"])) });
    const id = seedEvent(deps);
    const app = createApp(deps);

    const res = await call(app, "PUT", `/events/${id}/details`, { body: { version: 0, data: { memo: "x" } } });
    expect(res.status).toBe(403);
  });
});
