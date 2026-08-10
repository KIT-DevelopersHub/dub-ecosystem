import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import { collectAssigneeIds, MAX_TASK_PAGES, TASK_PAGE_LIMIT } from "../src/task-client";

function taskWith(id: string, assigneeId: string | null): task.Task {
  return {
    id,
    eventId: "evt_1",
    title: id,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId,
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    version: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

// A paged fake: chunks a fixed list into pages of `pageSize`, handing back an
// opaque numeric cursor. Records the cursors it was called with.
function pagedFetcher(all: task.Task[], pageSize: number) {
  const calls: (string | undefined)[] = [];
  const fetchPage = async (cursor?: string): Promise<task.ListTasksResponse> => {
    calls.push(cursor);
    const offset = cursor ? Number(cursor) : 0;
    const items = all.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    return { items, nextCursor: nextOffset < all.length ? String(nextOffset) : null };
  };
  return { fetchPage, calls };
}

describe("collectAssigneeIds — full pagination (task-client)", () => {
  it("walks every page, not just the first, and dedupes", async () => {
    // 450 tasks across 3 pages of 200/200/50 — the old single-page (limit 200)
    // fetch would have missed everyone on pages 2 and 3.
    const all = Array.from({ length: 450 }, (_, i) => taskWith(`task_${i}`, `user_${i}`));
    const { fetchPage, calls } = pagedFetcher(all, TASK_PAGE_LIMIT);

    const ids = await collectAssigneeIds(fetchPage);

    expect(ids).toHaveLength(450);
    expect(new Set(ids).size).toBe(450);
    expect(ids).toContain("user_449"); // last task's assignee, on the final page
    expect(calls).toEqual([undefined, "200", "400"]); // followed nextCursor twice
  });

  it("stops after one page when nextCursor is null", async () => {
    const all = [taskWith("t0", "user_A"), taskWith("t1", "user_B")];
    const { fetchPage, calls } = pagedFetcher(all, TASK_PAGE_LIMIT);
    const ids = await collectAssigneeIds(fetchPage);
    expect(new Set(ids)).toEqual(new Set(["user_A", "user_B"]));
    expect(calls).toEqual([undefined]);
  });

  it("skips null assignees and dedupes shared assignees across pages", async () => {
    const all = [
      taskWith("t0", "user_A"),
      taskWith("t1", null),
      taskWith("t2", "user_A"), // dup across page boundary
      taskWith("t3", "user_B"),
    ];
    const { fetchPage } = pagedFetcher(all, 2); // force 2 pages
    const ids = await collectAssigneeIds(fetchPage);
    expect([...ids].sort()).toEqual(["user_A", "user_B"]);
  });

  it("empty result set yields no assignees", async () => {
    const { fetchPage, calls } = pagedFetcher([], TASK_PAGE_LIMIT);
    expect(await collectAssigneeIds(fetchPage)).toEqual([]);
    expect(calls).toEqual([undefined]);
  });

  it("is bounded by the page-count safety cap on a misbehaving upstream", async () => {
    let calls = 0;
    // Upstream that never terminates (always returns a nextCursor).
    const fetchPage = async (): Promise<task.ListTasksResponse> => {
      calls++;
      return { items: [taskWith(`t${calls}`, `user_${calls}`)], nextCursor: "more" };
    };
    const ids = await collectAssigneeIds(fetchPage);
    expect(calls).toBe(MAX_TASK_PAGES); // did not loop forever
    expect(ids).toHaveLength(MAX_TASK_PAGES);
  });
});
