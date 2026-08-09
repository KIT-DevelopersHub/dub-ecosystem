import { describe, it, expect } from "vitest";
import { createMockEventApi } from "../src/api/mockData";
import { wrapUnknown } from "@dub/errors";
import { EventErrorCodes } from "../src/lib/errorMap";

describe("mock EventApi contract (test observations #1, #5, #7, #11)", () => {
  it("create -> list -> get is consistent (#1)", async () => {
    const api = createMockEventApi({ events: 0 });
    const created = await api.createEvent({ title: "新イベント" });
    expect(created.phase).toBe("planning");
    expect(created.version).toBe(1);

    const list = await api.listEvents({});
    expect(list.items.map((e) => e.id)).toContain(created.id);

    const detail = await api.getEvent(created.id);
    expect(detail.title).toBe("新イベント");
    expect(detail.actions).toEqual([]);
  });

  it("validation failure carries field details (#11)", async () => {
    const api = createMockEventApi({ events: 0 });
    await expect(api.createEvent({ title: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("optimistic version lock -> EVENT_VERSION_CONFLICT (#5)", async () => {
    const api = createMockEventApi({ events: 0 });
    const ev = await api.createEvent({ title: "e" });
    await api.updateEvent(ev.id, { version: ev.version, title: "e2" }); // bumps to v2
    // stale version
    const err = await api.updateEvent(ev.id, { version: ev.version, title: "e3" }).catch((e) => e);
    expect(wrapUnknown(err).code).toBe(EventErrorCodes.VERSION_CONFLICT);
  });

  it("invalid phase transition -> EVENT_INVALID_PHASE_TRANSITION (#7)", async () => {
    const api = createMockEventApi({ events: 0 });
    const ev = await api.createEvent({ title: "e" }); // planning
    const err = await api.updateEvent(ev.id, { version: ev.version, phase: "closed" }).catch((e) => e);
    expect(wrapUnknown(err).code).toBe(EventErrorCodes.INVALID_PHASE_TRANSITION);
  });

  it("archived event is immutable", async () => {
    const api = createMockEventApi({ events: 0 });
    const ev = await api.createEvent({ title: "e" });
    await api.archiveEvent(ev.id);
    const err = await api.updateEvent(ev.id, { version: ev.version + 1, title: "x" }).catch((e) => e);
    expect(wrapUnknown(err).code).toBe(EventErrorCodes.ARCHIVED_IMMUTABLE);
    // archived hidden from default list, visible with includeArchived
    const list = await api.listEvents({});
    expect(list.items.map((e) => e.id)).not.toContain(ev.id);
    const listArch = await api.listEvents({ includeArchived: true });
    expect(listArch.items.map((e) => e.id)).toContain(ev.id);
  });

  it("actions live under an event and sort by sortOrder", async () => {
    const api = createMockEventApi({ events: 0 });
    const ev = await api.createEvent({ title: "e" });
    const a1 = await api.createAction(ev.id, { kind: "generic", title: "A1" });
    const a2 = await api.createAction(ev.id, { kind: "generic", title: "A2" });
    expect(a2.sortOrder).toBeGreaterThan(a1.sortOrder);
    const actions = await api.listActions(ev.id);
    expect(actions.items.map((a) => a.title)).toEqual(["A1", "A2"]);
  });

  it("reorder via updateAction with version lock", async () => {
    const api = createMockEventApi({ events: 0 });
    const ev = await api.createEvent({ title: "e" });
    const a = await api.createAction(ev.id, { kind: "generic", title: "A" });
    const moved = await api.updateAction(a.id, { version: a.version, sortOrder: 42 });
    expect(moved.sortOrder).toBe(42);
    expect(moved.version).toBe(a.version + 1);
  });

  it("getUsers batches and rejects >50 ids (#8)", async () => {
    const api = createMockEventApi();
    const many = Array.from({ length: 51 }, (_, i) => `usr_${i}`);
    await expect(api.getUsers(many)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("cursor paging returns nextCursor when truncated (#9)", async () => {
    const api = createMockEventApi({ events: 0 });
    for (let i = 0; i < 5; i++) await api.createEvent({ title: `e${i}` });
    const page1 = await api.listEvents({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await api.listEvents({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
  });

  it("404 on unknown event/action (#10)", async () => {
    const api = createMockEventApi({ events: 0 });
    await expect(api.getEvent("evt_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.getAction("act_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
