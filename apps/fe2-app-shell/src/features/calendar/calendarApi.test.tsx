// Regression: the calendar must NEVER issue a bare, un-scoped GET /tasks. task-service's
// "/me rule" rejects a user's event-less list unless it is scoped to self (assigneeId or
// createdById), which is what made the production calendar fail with
// "タスクを取得できませんでした。" (old listAllTasks() sent no scope → 400). listMyTasks must
// query BOTH self lenses (担当 + 依頼) and de-dupe, mirroring マイタスク's「すべて」.
import { describe, it, expect } from "vitest";
import type { common, task } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import { createCalendarApi } from "./calendarApi.tsx";

const ME = "usr_me" as common.UserId;

function mkTask(id: string, over: Partial<task.Task> = {}): task.Task {
  return {
    id: id as common.TaskId,
    title: id,
    status: "todo",
    priority: "medium",
    eventId: null,
    assigneeId: null,
    createdBy: null,
    teamId: null,
    parentId: null,
    startAt: null,
    dueAt: null,
    archivedAt: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as task.Task;
}

/** Records every query the api-client is asked for; returns canned pages by lens. */
function stubApi(pages: (q: Record<string, unknown>) => task.ListTasksResponse): {
  api: ApiClient;
  queries: Record<string, unknown>[];
} {
  const queries: Record<string, unknown>[] = [];
  const api = {
    request: async <TRes,>(input: { query?: Record<string, unknown> }): Promise<TRes> => {
      const q = input.query ?? {};
      queries.push(q);
      return pages(q) as unknown as TRes;
    },
  } as unknown as ApiClient;
  return { api, queries };
}

describe("calendarApi.listMyTasks", () => {
  it("queries BOTH self lenses (assigneeId + createdById) and never a bare list", async () => {
    const { api, queries } = stubApi((q) => {
      if (q.assigneeId === ME) return { items: [mkTask("t_assigned", { assigneeId: ME })], nextCursor: null };
      if (q.createdById === ME) return { items: [mkTask("t_issued", { createdBy: ME })], nextCursor: null };
      return { items: [], nextCursor: null };
    });

    const tasks = await createCalendarApi(api).listMyTasks(ME);

    // Two lenses, each self-scoped. No query is allowed to omit BOTH scopes.
    expect(queries.length).toBe(2);
    expect(queries.some((q) => q.assigneeId === ME)).toBe(true);
    expect(queries.some((q) => q.createdById === ME)).toBe(true);
    for (const q of queries) {
      expect(q.assigneeId === ME || q.createdById === ME).toBe(true);
      expect(q.eventId).toBeUndefined();
    }
    expect(tasks.map((t) => t.id).sort()).toEqual(["t_assigned", "t_issued"]);
  });

  it("de-dupes a task that is both assigned to and issued by the caller", async () => {
    const both = mkTask("t_both", { assigneeId: ME, createdBy: ME });
    const { api } = stubApi(() => ({ items: [both], nextCursor: null }));

    const tasks = await createCalendarApi(api).listMyTasks(ME);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("t_both");
  });
});
