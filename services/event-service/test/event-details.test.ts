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
    expect(got.json.data).toEqual({
      overview: "",
      venue: "",
      access: "",
      capacity: "",
      belongings: "",
      budget: "",
      operations: "",
      memo: "",
      schedule: [],
      speakers: [],
      sponsors: [],
      checklist: [],
      links: [],
      contacts: [],
    });
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

  it("persists the rich event-ops sections (schedule/speakers/sponsors/checklist) and drops blank rows", async () => {
    const deps = makeDeps();
    const id = seedEvent(deps);
    const app = createApp(deps);

    const body = {
      version: 0,
      data: {
        access: "JR金沢駅 徒歩5分",
        capacity: "来場400名 / 運営20名",
        budget: "総予算180万円",
        operations: "08:00 設営 / 09:00 受付",
        schedule: [
          { time: "10:00", title: "基調講演", note: "大ホール" },
          { time: "", title: "", note: "" }, // dropped (all empty)
        ],
        speakers: [{ name: "井上", role: "CTO", topic: "開発組織" }],
        sponsors: [{ name: "アルファオメガ", tier: "Gold", status: "契約済" }],
        checklist: [
          { label: "会場鍵の受取", done: true },
          { label: "", done: false }, // dropped (no label)
        ],
      },
    };
    const saved = await call(app, "PUT", `/events/${id}/details`, { body });
    expect(saved.status).toBe(200);
    expect(saved.json.data.access).toBe("JR金沢駅 徒歩5分");
    expect(saved.json.data.capacity).toBe("来場400名 / 運営20名");
    expect(saved.json.data.operations).toBe("08:00 設営 / 09:00 受付");
    expect(saved.json.data.schedule).toHaveLength(1);
    expect(saved.json.data.schedule[0].title).toBe("基調講演");
    expect(saved.json.data.speakers[0].name).toBe("井上");
    expect(saved.json.data.sponsors[0].tier).toBe("Gold");
    expect(saved.json.data.checklist).toHaveLength(1);
    expect(saved.json.data.checklist[0].done).toBe(true);

    const got = await call(app, "GET", `/events/${id}/details`);
    expect(got.json.data.budget).toBe("総予算180万円");
    expect(got.json.data.checklist[0].label).toBe("会場鍵の受取");
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
