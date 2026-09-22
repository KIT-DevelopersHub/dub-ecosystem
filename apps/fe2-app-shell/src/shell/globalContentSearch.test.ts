import { describe, it, expect, vi } from "vitest";
import type { event, task } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { createGlobalContentSearch } from "./globalContentSearch.ts";

const EVENTS: event.EventSummary[] = [
  { id: "evt_1", title: "北陸ITカンファレンス 2026", phase: "preparing", startsAt: null },
  { id: "evt_2", title: "運営定例ミーティング", phase: "planning", startsAt: null },
];

const TASKS: task.Task[] = [
  {
    id: "tsk_1", eventId: "evt_1", title: "登壇者スケジュール確定", description: null,
    status: "todo", priority: "medium", assigneeId: "usr_me", dueAt: null, origin: "internal",
    archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
  },
  {
    id: "tsk_2", eventId: "evt_1", title: "会場レイアウト図作成", description: null,
    status: "todo", priority: "medium", assigneeId: "usr_me", dueAt: null, origin: "internal",
    archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
  },
];

function fakeApi(opts: { eventsFail?: boolean; tasksFail?: boolean } = {}): ApiClient {
  return {
    events: {
      get: vi.fn().mockImplementation(() => {
        if (opts.eventsFail) return Promise.reject(new Error("events down"));
        return Promise.resolve({ items: EVENTS, nextCursor: null });
      }),
    },
    tasks: {
      get: vi.fn().mockImplementation(() => {
        if (opts.tasksFail) return Promise.reject(new Error("tasks down"));
        return Promise.resolve({ items: TASKS, nextCursor: null });
      }),
    },
  } as unknown as ApiClient;
}

describe("createGlobalContentSearch", () => {
  it("matches events by title substring (case-insensitive) and navigates to /events/:id", async () => {
    const onNavigate = vi.fn();
    const search = createGlobalContentSearch({ api: fakeApi(), currentUserId: null, onNavigate });
    const results = await search("カンファレンス", new AbortController().signal);
    const evt = results.find((r) => r.id === "content:event:evt_1");
    expect(evt).toBeDefined();
    expect(evt!.group).toBe("イベント");
    evt!.run();
    expect(onNavigate).toHaveBeenCalledWith("/events/evt_1");
  });

  it("matches the caller's own tasks and navigates to the event-scoped task detail", async () => {
    const onNavigate = vi.fn();
    const search = createGlobalContentSearch({ api: fakeApi(), currentUserId: "usr_me", onNavigate });
    const results = await search("会場", new AbortController().signal);
    const t = results.find((r) => r.id === "content:task:tsk_2");
    expect(t).toBeDefined();
    expect(t!.group).toBe("タスク");
    t!.run();
    expect(onNavigate).toHaveBeenCalledWith("/events/evt_1/tasks/tsk_2");
  });

  it("scopes the task provider to assigneeId=currentUserId (the /me rule)", async () => {
    const api = fakeApi();
    const search = createGlobalContentSearch({ api, currentUserId: "usr_me", onNavigate: vi.fn() });
    await search("会場", new AbortController().signal);
    expect(api.tasks.get).toHaveBeenCalledWith("", expect.objectContaining({ assigneeId: "usr_me" }));
  });

  it("skips the task provider (no crash) while currentUserId is not yet known", async () => {
    const api = fakeApi();
    const search = createGlobalContentSearch({ api, currentUserId: null, onNavigate: vi.fn() });
    const results = await search("会場", new AbortController().signal);
    expect(results.some((r) => r.group === "タスク")).toBe(false);
    expect(api.tasks.get).not.toHaveBeenCalled();
  });

  it("returns no matches for a query that matches nothing", async () => {
    const search = createGlobalContentSearch({ api: fakeApi(), currentUserId: "usr_me", onNavigate: vi.fn() });
    const results = await search("存在しない何か", new AbortController().signal);
    expect(results).toEqual([]);
  });

  it("degrades gracefully when one provider rejects — the other's results still come back", async () => {
    const api = fakeApi({ eventsFail: true });
    const search = createGlobalContentSearch({ api, currentUserId: "usr_me", onNavigate: vi.fn() });
    const results = await search("会場", new AbortController().signal);
    expect(results.some((r) => r.id === "content:task:tsk_2")).toBe(true);
    expect(results.some((r) => r.group === "イベント")).toBe(false);
  });

  it("caps results per provider at the extension point's limit", async () => {
    const manyTasks: task.Task[] = Array.from({ length: 20 }, (_, i) => ({
      ...TASKS[0]!,
      id: `tsk_many_${i}`,
      title: `検索対象タスク${i}`,
    }));
    const api = {
      events: { get: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
      tasks: { get: vi.fn().mockResolvedValue({ items: manyTasks, nextCursor: null }) },
    } as unknown as ApiClient;
    const search = createGlobalContentSearch({ api, currentUserId: "usr_me", onNavigate: vi.fn() });
    const results = await search("検索対象", new AbortController().signal);
    expect(results.length).toBeLessThanOrEqual(6);
  });
});
