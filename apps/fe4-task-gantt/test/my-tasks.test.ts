import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import {
  lensQueries,
  mergeTasks,
  applyMyTasksFilter,
  sortMyTasks,
  isOverdue,
  emptyMyTasksFilter,
  myTasksFilterActiveCount,
} from "../src/domain/my-tasks";

const NOW = Date.parse("2026-08-13T09:00:00Z");

function mk(over: Partial<task.Task> & { id: string }): task.Task {
  return {
    id: over.id,
    eventId: over.eventId ?? "evt_1",
    title: over.title ?? "T",
    description: null,
    status: over.status ?? "todo",
    priority: over.priority ?? "medium",
    assigneeId: over.assigneeId ?? null,
    teamId: over.teamId ?? null,
    createdBy: over.createdBy ?? "usr_me",
    dueAt: over.dueAt ?? null,
    origin: "internal",
    archivedAt: null,
    createdAt: over.createdAt ?? "2026-08-01T00:00:00Z",
    updatedAt: over.updatedAt ?? "2026-08-01T00:00:00Z",
    version: 1,
  };
}

describe("lensQueries", () => {
  it("assigned lens queries only the caller's assigned tasks", () => {
    expect(lensQueries("usr_me", "assigned")).toEqual([{ assigneeId: "usr_me", limit: 200 }]);
  });
  it("requested lens queries only tasks the caller issued", () => {
    expect(lensQueries("usr_me", "requested")).toEqual([{ createdById: "usr_me", limit: 200 }]);
  });
  it("all lens queries both sides (assigned + issued)", () => {
    expect(lensQueries("usr_me", "all")).toHaveLength(2);
  });
});

describe("mergeTasks", () => {
  it("de-duplicates by id across pages (a task assigned to and issued by me appears once)", () => {
    const t = mk({ id: "task_1", assigneeId: "usr_me", createdBy: "usr_me" });
    const merged = mergeTasks([t], [t]);
    expect(merged).toHaveLength(1);
  });
});

describe("applyMyTasksFilter", () => {
  const tasks = [
    mk({ id: "task_1", title: "会場予約", status: "todo", assigneeId: "usr_a", createdBy: "usr_me", teamId: "team_ops", dueAt: "2026-08-10T00:00:00Z" }),
    mk({ id: "task_2", title: "配信準備", status: "in_progress", assigneeId: "usr_me", createdBy: "usr_b", teamId: "team_content", dueAt: "2026-08-13T00:00:00Z" }),
    mk({ id: "task_3", title: "懇親会", status: "done", assigneeId: "usr_c", createdBy: "usr_me", dueAt: null }),
  ];

  it("search matches the title (case-insensitive)", () => {
    const r = applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), search: "配信" }, NOW);
    expect(r.map((t) => t.id)).toEqual(["task_2"]);
  });
  it("status filter narrows to the selected statuses", () => {
    const r = applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), status: ["done"] }, NOW);
    expect(r.map((t) => t.id)).toEqual(["task_3"]);
  });
  it("assignee filter (to) and requester filter (from) are independent", () => {
    expect(applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), assigneeId: "usr_me" }, NOW).map((t) => t.id)).toEqual(["task_2"]);
    expect(applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), requesterId: "usr_me" }, NOW).map((t) => t.id)).toEqual(["task_1", "task_3"]);
  });
  it("team filter matches task.teamId", () => {
    expect(applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), teamId: "team_ops" }, NOW).map((t) => t.id)).toEqual(["task_1"]);
  });
  it("due=overdue keeps only past-due open tasks; due=none keeps tasks without a date", () => {
    expect(applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), due: "overdue" }, NOW).map((t) => t.id)).toEqual(["task_1"]);
    expect(applyMyTasksFilter(tasks, { ...emptyMyTasksFilter(), due: "none" }, NOW).map((t) => t.id)).toEqual(["task_3"]);
  });
});

describe("isOverdue", () => {
  it("is false for done/cancelled even when past due", () => {
    expect(isOverdue(mk({ id: "x", status: "done", dueAt: "2026-08-01T00:00:00Z" }), NOW)).toBe(false);
  });
  it("is true for an open task before today", () => {
    expect(isOverdue(mk({ id: "x", status: "todo", dueAt: "2026-08-10T00:00:00Z" }), NOW)).toBe(true);
  });
});

describe("sortMyTasks", () => {
  it("keeps open tasks above closed ones when sorting by due", () => {
    const tasks = [
      mk({ id: "done", status: "done", dueAt: "2026-08-01T00:00:00Z" }),
      mk({ id: "open", status: "todo", dueAt: "2026-08-20T00:00:00Z" }),
    ];
    expect(sortMyTasks(tasks, "due").map((t) => t.id)).toEqual(["open", "done"]);
  });
  it("priority sort orders urgent before low", () => {
    const tasks = [mk({ id: "low", priority: "low" }), mk({ id: "urg", priority: "urgent" })];
    expect(sortMyTasks(tasks, "priority").map((t) => t.id)).toEqual(["urg", "low"]);
  });
});

describe("myTasksFilterActiveCount", () => {
  it("counts each active dimension", () => {
    expect(myTasksFilterActiveCount(emptyMyTasksFilter())).toBe(0);
    expect(
      myTasksFilterActiveCount({ ...emptyMyTasksFilter(), search: "x", status: ["todo", "done"], due: "today" }),
    ).toBe(4);
  });
});
