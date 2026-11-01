import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { event, task } from "@dub/types";
import type { ApiClient, RequestInput } from "../lib/api-client.tsx";
import { createGlobalContentSearch, type ContentSearchDeps } from "./globalContentSearch.ts";

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

type FakeApi = ApiClient & { request: ReturnType<typeof vi.fn> };

function fakeApi(
  opts: { eventsFail?: boolean; tasksFail?: boolean; events?: event.EventSummary[]; tasks?: task.Task[] } = {},
): FakeApi {
  return {
    request: vi.fn().mockImplementation((input: RequestInput) => {
      if (input.path === "/api/v1/events") {
        if (opts.eventsFail) return Promise.reject(new Error("events down"));
        return Promise.resolve({ items: opts.events ?? EVENTS, nextCursor: null });
      }
      if (input.path === "/api/v1/tasks") {
        if (opts.tasksFail) return Promise.reject(new Error("tasks down"));
        return Promise.resolve({ items: opts.tasks ?? TASKS, nextCursor: null });
      }
      return Promise.reject(new Error(`unexpected ${input.path}`));
    }),
  } as unknown as FakeApi;
}

function deps(api: ApiClient, over: Partial<ContentSearchDeps> = {}): ContentSearchDeps {
  return {
    api,
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    currentUserId: null,
    onNavigate: vi.fn(),
    ...over,
  };
}

const sig = () => new AbortController().signal;

describe("createGlobalContentSearch", () => {
  it("matches events by title (case-insensitive) and navigates to /events/:id", async () => {
    const onNavigate = vi.fn();
    const search = createGlobalContentSearch(deps(fakeApi(), { onNavigate }));
    const results = await search("カンファレンス", sig());
    const evt = results.find((r) => r.id === "content:event:evt_1");
    expect(evt).toBeDefined();
    expect(evt!.group).toBe("イベント");
    evt!.run();
    expect(onNavigate).toHaveBeenCalledWith("/events/evt_1");
  });

  it("folds width/case/kana so ｶﾝﾌｧﾚﾝｽ and かんふぁれんす find カンファレンス", async () => {
    const search = createGlobalContentSearch(deps(fakeApi()));
    expect((await search("ｶﾝﾌｧﾚﾝｽ", sig())).some((r) => r.id === "content:event:evt_1")).toBe(true);
    expect((await search("かんふぁれんす", sig())).some((r) => r.id === "content:event:evt_1")).toBe(true);
    expect((await search("ｉｔ", sig())).some((r) => r.id === "content:event:evt_1")).toBe(true);
  });

  it("matches the caller's own tasks and navigates to the event-scoped task detail", async () => {
    const onNavigate = vi.fn();
    const search = createGlobalContentSearch(deps(fakeApi(), { currentUserId: "usr_me", onNavigate }));
    const results = await search("会場", sig());
    const t = results.find((r) => r.id === "content:task:tsk_2");
    expect(t).toBeDefined();
    expect(t!.group).toBe("タスク");
    t!.run();
    expect(onNavigate).toHaveBeenCalledWith("/events/evt_1/tasks/tsk_2");
  });

  it("scopes the task provider to assigneeId=currentUserId (the /me rule) and never sends the term", async () => {
    const api = fakeApi();
    const search = createGlobalContentSearch(deps(api, { currentUserId: "usr_me" }));
    await search("会場", sig());
    const taskCall = api.request.mock.calls.map((c) => c[0] as RequestInput).find((i) => i.path === "/api/v1/tasks");
    expect(taskCall?.query).toEqual({ assigneeId: "usr_me", limit: 200 });
    expect(taskCall?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetches each catalog once and filters later queries from the cache (no request per keystroke)", async () => {
    const api = fakeApi();
    const search = createGlobalContentSearch(deps(api, { currentUserId: "usr_me" }));
    await search("会", sig());
    expect(api.request).toHaveBeenCalledTimes(2);
    for (const q of ["会場", "会場レ", "カンファ", "存在しない"]) await search(q, sig());
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("skips the task provider (no crash) while currentUserId is not yet known", async () => {
    const api = fakeApi();
    const search = createGlobalContentSearch(deps(api));
    const results = await search("会場", sig());
    expect(results.some((r) => r.group === "タスク")).toBe(false);
    expect(api.request.mock.calls.some((c) => (c[0] as RequestInput).path === "/api/v1/tasks")).toBe(false);
  });

  it("returns no matches for a query that matches nothing", async () => {
    const search = createGlobalContentSearch(deps(fakeApi(), { currentUserId: "usr_me" }));
    expect(await search("存在しない何か", sig())).toEqual([]);
  });

  it("degrades gracefully when one provider rejects — the other's results still come back", async () => {
    const search = createGlobalContentSearch(deps(fakeApi({ eventsFail: true }), { currentUserId: "usr_me" }));
    const results = await search("会場", sig());
    expect(results.some((r) => r.id === "content:task:tsk_2")).toBe(true);
    expect(results.some((r) => r.group === "イベント")).toBe(false);
  });

  it("caps results per provider at the extension point's limit", async () => {
    const manyTasks: task.Task[] = Array.from({ length: 20 }, (_, i) => ({
      ...TASKS[0]!,
      id: `tsk_many_${i}`,
      title: `検索対象タスク${i}`,
    }));
    const search = createGlobalContentSearch(deps(fakeApi({ events: [], tasks: manyTasks }), { currentUserId: "usr_me" }));
    expect((await search("検索対象", sig())).length).toBeLessThanOrEqual(6);
  });
});
