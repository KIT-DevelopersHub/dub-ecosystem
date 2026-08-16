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
