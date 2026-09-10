// ①グローバル検索: CONTENT providers for the Cmd/Ctrl+K palette (CommandPalette's
// `contentSearch` prop). Turns a typed query into PaletteCommands the palette can
// list/run, on top of the SAME existing list endpoints the rest of the app already
// uses (GET /events, GET /tasks) — no new backend endpoint, no contract change.
//
// Extension point: adding a new searchable resource (member/mail/chat, …) means
// writing one more `ContentSearchProvider` below and adding it to PROVIDERS — the
// palette and AppShellLayout wiring need no changes.
//
// Scope (MVP, per plan): task + event only.
//   - Events: GET /api/v1/events lists every event the viewer can read; filtered
//     client-side by title substring (org-wide event count is small — no pagination
//     needed yet; see LIST_LIMIT).
//   - Tasks: GET /api/v1/tasks?assigneeId=<self> — task-service's "/me rule" allows
//     omitting eventId only when listing the CALLER's own tasks, so this searches
//     "自分が担当のタスク" across every event without a cross-event backend change.
//     Widening to "all tasks I can see" needs a real search/eventId-scoped endpoint
//     (task-service today requires eventId otherwise) — a follow-up, not this MVP.
import type { ApiClient } from "../lib/api-client.tsx";
import type { common, event, task } from "@dub/types";
import type { PaletteCommand } from "./CommandPalette.tsx";

/** Results per provider, so one huge match never crowds out the other group. */
const RESULT_LIMIT_PER_GROUP = 6;
/** How many rows to pull before client-side filtering (small org-wide catalogs). */
const LIST_LIMIT = 200;

function norm(s: string): string {
  return s.toLowerCase();
}

interface ContentSearchProvider {
  /** Palette section heading this provider's results are grouped under. */
  group: string;
  /** Resolve query -> PaletteCommand[] (already limited to RESULT_LIMIT_PER_GROUP). */
  search(deps: ContentSearchDeps, query: string, signal: AbortSignal): Promise<PaletteCommand[]>;
}

export interface ContentSearchDeps {
  api: ApiClient;
  /** Current viewer's user id (GET /me) — scopes the task provider's "自分の" search.
   *  null while /me is still loading; the task provider no-ops until it resolves. */
  currentUserId: common.UserId | null;
  onNavigate: (path: string) => void;
}

const eventProvider: ContentSearchProvider = {
  group: "イベント",
  async search({ api, onNavigate }, query, signal) {
    const res = await api.events.get<event.ListEventsResponse>("", { limit: LIST_LIMIT });
    if (signal.aborted) return [];
    const q = norm(query);
    return res.items
      .filter((e) => norm(e.title).includes(q))
      .slice(0, RESULT_LIMIT_PER_GROUP)
      .map(
        (e): PaletteCommand => ({
          id: `content:event:${e.id}`,
          label: e.title,
          group: "イベント",
          icon: "calendar",
          run: () => onNavigate(`/events/${e.id}`),
        }),
      );
  },
};

const myTaskProvider: ContentSearchProvider = {
  group: "タスク",
  async search({ api, currentUserId, onNavigate }, query, signal) {
    if (!currentUserId) return []; // /me still loading — no self-scope to search yet
    const res = await api.tasks.get<task.ListTasksResponse>("", {
      assigneeId: currentUserId,
      limit: LIST_LIMIT,
    });
    if (signal.aborted) return [];
    const q = norm(query);
    return res.items
      .filter((t) => norm(t.title).includes(q))
      .slice(0, RESULT_LIMIT_PER_GROUP)
      .map(
        (t): PaletteCommand => ({
          id: `content:task:${t.id}`,
          label: t.title,
          group: "タスク",
          icon: "check-square",
          // MYタスクなので担当者名は付けず、所属イベント名だけ添える意味は薄い(1件文脈)。
          run: () => onNavigate(`/events/${t.eventId}/tasks/${t.id}`),
        }),
      );
  },
};

// Task group first (the more actionable "何をやるか" jump), then event.
const PROVIDERS: readonly ContentSearchProvider[] = [myTaskProvider, eventProvider];

/** Build the `contentSearch` function CommandPalette calls. All providers run in
 *  parallel; one provider failing (network/permission) never blocks the others —
 *  each provider's own errors are swallowed here so a partial result set still
 *  renders instead of the whole search failing silently. */
export function createGlobalContentSearch(
  deps: ContentSearchDeps,
): (query: string, signal: AbortSignal) => Promise<PaletteCommand[]> {
  return async (query, signal) => {
    const settled = await Promise.allSettled(PROVIDERS.map((p) => p.search(deps, query, signal)));
    const out: PaletteCommand[] = [];
    for (const s of settled) {
      if (s.status === "fulfilled") out.push(...s.value);
    }
    return out;
  };
}
