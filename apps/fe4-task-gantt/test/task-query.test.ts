import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import {
  emptyFilter,
  toListTasksQuery,
  filterToSearchParams,
  searchParamsToFilter,
  appendPage,
} from "../src/domain/task-query";

const mk = (id: string): task.Task => ({
  id, eventId: "evt_1", title: id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("task-query (design test 1/12)", () => {
  it("builds ListTasksQuery with composite filters", () => {
    const f = { ...emptyFilter("evt_1"), status: ["todo", "done"] as task.TaskStatus[], assigneeId: "usr_a", includeArchived: true };
    const q = toListTasksQuery(f);
    expect(q).toEqual({ eventId: "evt_1", status: ["todo", "done"], assigneeId: "usr_a", includeArchived: true });
  });

  it("omits empty filter fields (no eventId collision, task uses eventId)", () => {
    expect(toListTasksQuery(emptyFilter("evt_1"))).toEqual({ eventId: "evt_1" });
  });

  it("round-trips filter <-> URLSearchParams", () => {
    const f = { ...emptyFilter("evt_1"), status: ["blocked"] as task.TaskStatus[], assigneeId: "usr_x", includeArchived: true };
    const round = searchParamsToFilter("evt_1", filterToSearchParams(f));
    expect(round.status).toEqual(["blocked"]);
    expect(round.assigneeId).toBe("usr_x");
    expect(round.includeArchived).toBe(true);
  });

  it("drops invalid status tokens from the URL", () => {
    const p = new URLSearchParams("status=todo,bogus,done");
    expect(searchParamsToFilter("evt_1", p).status).toEqual(["todo", "done"]);
  });

  it("appendPage merges LoadMore without duplicates or gaps", () => {
    const first = [mk("t1"), mk("t2")];
    const page = { items: [mk("t2"), mk("t3")], nextCursor: null };
    const merged = appendPage(first, page);
    expect(merged.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });
});
