import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { MockApiClient } from "../src/api/mock-client";
import * as api from "../src/api/endpoints";

const seedTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1, ...over,
});

describe("gantt endpoints (design tests 4/6/8/12)", () => {
  it("getGantt returns DTO derived from tasks (rows + dependencies)", async () => {
    const c = new MockApiClient({
      tasks: [seedTask("t1", { status: "done" }), seedTask("t2")],
      dependencies: [{ id: "t1->t2", fromTaskId: "t1", toTaskId: "t2", type: "FS", lagDays: 0 }],
      rowDates: { t1: { startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-05T00:00:00Z" } },
    });
    const dto = await api.getGantt(c, "evt_1");
    expect(dto.eventId).toBe("evt_1");
    expect(dto.rows).toHaveLength(2);
    expect(dto.rows.find((r) => r.taskId === "t1")!.progressPercent).toBe(100); // done=100
    expect(dto.dependencies[0]!.type).toBe("FS");
  });

  it("editing a task's startAt/dueAt (detail panel path) moves the gantt bar (regression: 詳細で日付を変更してもバーが変わらない)", async () => {
    // A seeded row whose bar window came from the rowDates read-model override.
    const c = new MockApiClient({
      tasks: [seedTask("t1", { startAt: "2026-08-01T00:00:00.000Z", dueAt: "2026-08-05T00:00:00.000Z" })],
      rowDates: { t1: { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-05T00:00:00.000Z" } },
    });
    const before = await api.getGantt(c, "evt_1");
    const b = before.rows.find((r) => r.taskId === "t1")!;
    expect(b.startsAt).toBe("2026-08-01T00:00:00.000Z");
    expect(b.endsAt).toBe("2026-08-05T00:00:00.000Z");

    // Edit dates the way the detail panel does: PATCH /tasks/:id with startAt/dueAt.
    await api.updateTask(c, "t1", {
      version: 1,
      startAt: "2026-08-10T00:00:00.000Z",
      dueAt: "2026-08-14T00:00:00.000Z",
    });

    // The gantt DTO must reflect the new window (previously the stale rowDates override
    // won, so the bar never moved).
    const after = await api.getGantt(c, "evt_1");
    const a = after.rows.find((r) => r.taskId === "t1")!;
    expect(a.startsAt).toBe("2026-08-10T00:00:00.000Z");
    expect(a.endsAt).toBe("2026-08-14T00:00:00.000Z");
  });

  it("gantt bar start comes from the task's startAt column so 詳細の開始日 == バーの開始 (regression: 値とバーの不一致)", async () => {
    const c = new MockApiClient({
      tasks: [seedTask("t1", { startAt: "2026-09-02T00:00:00.000Z", dueAt: "2026-09-09T00:00:00.000Z" })],
    });
    const dto = await api.getGantt(c, "evt_1");
    const row = dto.rows.find((r) => r.taskId === "t1")!;
    // No rowDates override → the bar window is the task's real startAt/dueAt, exactly
    // what the detail panel shows, so the three surfaces agree.
    expect(row.startsAt).toBe("2026-09-02T00:00:00.000Z");
    expect(row.endsAt).toBe("2026-09-09T00:00:00.000Z");
  });

  it("getGantt sends the event as ?eventId= (regression: gantt-service reads eventId, not event)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    await api.getGantt(c, "evt_1");
    const call = c.calls.find((r) => r.path === "/api/v1/gantt");
    expect(call?.query?.eventId).toBe("evt_1");
    expect(call?.query?.event).toBeUndefined(); // never the stale ?event= key
  });

  it("getGanttFresh adds Cache-Control: no-cache (test 6)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    await api.getGanttFresh(c, "evt_1");
    const call = c.calls.find((r) => r.path === "/api/v1/gantt");
    expect(call?.headers?.["Cache-Control"]).toBe("no-cache");
    expect(call?.query?.eventId).toBe("evt_1"); // wire key = gantt.GetGanttQuery.eventId (SoT)
  });

  it("gantt view state round-trips: PUT then GET (test 8)", async () => {
    const c = new MockApiClient({ tasks: [seedTask("t1")] });
    await api.putGanttView(c, "evt_1", { zoom: "month", collapsedTaskIds: ["t1"] });
    const view = await api.getGanttView(c, "evt_1");
    expect(view.zoom).toBe("month");
    expect(view.collapsedTaskIds).toEqual(["t1"]);
  });

  it("identity batch resolve uses ?ids= (test 13)", async () => {
    const c = new MockApiClient({ users: [{ id: "u1", displayName: "One", avatarUrl: null }] });
    const res = await api.resolveUsers(c, ["u1", "u2"]);
    expect(res.items.map((u) => u.id)).toEqual(["u1"]); // only known resolved
    const call = c.calls.find((r) => r.path === "/api/v1/identity/users");
    expect(call?.query?.ids).toBe("u1,u2");
  });
});
