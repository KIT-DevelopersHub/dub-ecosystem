// Zustand store: thin reactive wrapper over the pure task-store reducer. Holds
// the shared task cache for all three views + the optimistic mutation actions.
// The pure logic lives in domain/task-store (tested there); this adds reactivity
// and API wiring only.
import { create } from "zustand";
import type { task, common } from "@dub/types";
import type { ApiClient, DisplayableError } from "../contracts/spa-shell";
import { toDisplayableError } from "../contracts/spa-shell";
import * as api from "../api/endpoints";
import {
  type TaskMap,
  indexTasks,
  applyOptimistic,
  rollback,
  confirm,
  remove,
  upsert,
  toList,
  byStatus,
  type OptimisticPatch,
} from "../domain/task-store";
import { mapError, type ErrorUx } from "../domain/error-mapping";

export interface TaskStoreState {
  tasks: TaskMap;
  nextCursor: string | null;
  /** UX-routed error (banner/dialog/inline action). */
  lastError: ErrorUx | null;
  /** Raw displayable error (code/message/details/correlationId) for the ErrorDialog
   *  + inline field mapping. Kept alongside lastError so failures always carry their
   *  reason — never swallowed. */
  lastErrorDetail: DisplayableError | null;
  // queries
  list: () => task.Task[];
  column: (status: task.TaskStatus) => task.Task[];
  // loads
  load: (client: ApiClient, q: task.ListTasksQuery) => Promise<void>;
  /** Load EVERY page for the query (cursor-paginated) into the cache. The gantt
   *  workspace must hold all tasks — a single page caps at 200 (server max), so an
   *  event with >200 tasks (e.g. the 216-task conference) silently dropped the tail
   *  from the store, hiding those rows from the timeline and making their edits
   *  impossible. This walks nextCursor to completion. */
  loadAll: (client: ApiClient, q: task.ListTasksQuery) => Promise<void>;
  /** Best-effort re-sync of the task cache used AFTER a write has already succeeded.
   *  Identical fetch to `loadAll`, but a read failure here is NON-fatal: it must never
   *  set `lastError` (the write is already committed — a failed reconciling read is not
   *  a save failure). On success it refreshes the cache and clears any stale error; on
   *  failure it leaves the (optimistic, now-authoritative) cache untouched and silent.
   *  Returns true iff the reconcile fetch succeeded (caller may background-retry). */
  reconcile: (client: ApiClient, q: task.ListTasksQuery) => Promise<boolean>;
  loadMore: (client: ApiClient, q: task.ListTasksQuery) => Promise<void>;
  // optimistic mutation (board D&D / gantt bar D&D / inline edit)
  patchOptimistic: (
    client: ApiClient,
    id: common.TaskId,
    patch: OptimisticPatch["changes"],
    version: number,
    body: task.UpdateTaskRequest,
  ) => Promise<task.Task | null>;
  // create — optimistic when a `provisional` task is supplied (shown instantly,
  // reconciled with the server row, rolled back on failure).
  create: (client: ApiClient, body: task.CreateTaskRequest, provisional?: task.Task) => Promise<task.Task | null>;
  // delete — optimistic (removed instantly, restored on failure).
  removeTask: (client: ApiClient, id: common.TaskId) => Promise<boolean>;
  // deferred-commit delete (undoable): drop the row locally now (returns the snapshot),
  // re-attach on undo, and commit the DELETE separately once the grace window elapses.
  /** Remove a task from the cache WITHOUT calling the API; returns the removed row
   *  (or null) so an undo can put it straight back. */
  detachTask: (id: common.TaskId) => task.Task | null;
  /** Re-insert a previously detached task (undo of detachTask). No-op for null. */
  attachTask: (t: task.Task | null) => void;
  /** Commit the server-side DELETE for a task already detached locally. Routes the
   *  error (does NOT re-insert — the caller's onCommitError restores). */
  commitDelete: (client: ApiClient, id: common.TaskId) => Promise<boolean>;
  /** Surface an error raised OUTSIDE the store (e.g. a relation save / dependency
   *  replace that bypasses the store) so it is never lost. */
  reportError: (e: unknown) => void;
  /** Clear the current error (dialog closed / retried). */
  clearError: () => void;
}

/** Build both error projections from any thrown value (never swallow a failure). */
function errState(e: unknown): { lastError: ErrorUx; lastErrorDetail: DisplayableError } {
  const detail = toDisplayableError(e);
  return { lastError: mapError(detail), lastErrorDetail: detail };
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: {},
  nextCursor: null,
  lastError: null,
  lastErrorDetail: null,

  list: () => toList(get().tasks),
  column: (status) => byStatus(get().tasks, status),

  async load(client, q) {
    try {
      const res = await api.listTasks(client, q);
      set({ tasks: indexTasks(res.items), nextCursor: res.nextCursor, lastError: null, lastErrorDetail: null });
    } catch (e) {
      set(errState(e));
    }
  },

  async loadAll(client, q) {
    try {
      const MAX_PAGES = 50; // safety bound (>=200*50 tasks); avoids an infinite loop on a bad cursor
      const first = await api.listTasks(client, q);
      const all = [...first.items];
      let cursor = first.nextCursor;
      for (let page = 0; page < MAX_PAGES && cursor; page++) {
        const res = await api.listTasks(client, { ...q, cursor });
        all.push(...res.items);
        cursor = res.nextCursor;
      }
      set({ tasks: indexTasks(all), nextCursor: null, lastError: null, lastErrorDetail: null });
    } catch (e) {
      set(errState(e));
    }
  },

  async reconcile(client, q) {
    // Post-write re-sync. NEVER writes lastError: a failure of this read must not be
    // mistaken for a save failure (the mutation already succeeded). Mirrors loadAll's
    // full-pagination walk so the >200-task events stay complete.
    try {
      const MAX_PAGES = 50;
      const first = await api.listTasks(client, q);
      const all = [...first.items];
      let cursor = first.nextCursor;
      for (let page = 0; page < MAX_PAGES && cursor; page++) {
        const res = await api.listTasks(client, { ...q, cursor });
        all.push(...res.items);
        cursor = res.nextCursor;
      }
      set({ tasks: indexTasks(all), nextCursor: null, lastError: null, lastErrorDetail: null });
      return true;
    } catch {
      // leave the optimistic cache in place and stay silent — caller retries later.
      return false;
    }
  },

  async loadMore(client, q) {
    const cursor = get().nextCursor;
    if (!cursor) return;
    try {
      const res = await api.listTasks(client, { ...q, cursor });
      set((s) => {
        const next = { ...s.tasks };
        for (const t of res.items) next[t.id] = t;
        return { tasks: next, nextCursor: res.nextCursor };
      });
    } catch (e) {
      set(errState(e));
    }
  },

  async patchOptimistic(client, id, changes, _version, body) {
    const [optimistic, snapshot] = applyOptimistic(get().tasks, { id, changes });
    set({ tasks: optimistic });
    try {
      const server = await api.updateTask(client, id, body);
      set((s) => ({ tasks: confirm(s.tasks, server), lastError: null, lastErrorDetail: null }));
      return server;
    } catch (e) {
      set((s) => ({ tasks: rollback(s.tasks, snapshot), ...errState(e) }));
      return null;
    }
  },

  async create(client, body, provisional) {
    // Optimistic path: show the provisional row instantly, then swap it for the
    // authoritative server task; on failure drop it and surface the reason.
    if (provisional) set((s) => ({ tasks: upsert(s.tasks, provisional) }));
    try {
      const server = await api.createTask(client, body);
      set((s) => {
        const base = provisional ? remove(s.tasks, provisional.id) : s.tasks;
        return { tasks: upsert(base, server), lastError: null, lastErrorDetail: null };
      });
      return server;
    } catch (e) {
      set((s) => ({
        tasks: provisional ? remove(s.tasks, provisional.id) : s.tasks,
        ...errState(e),
      }));
      return null;
    }
  },

  async removeTask(client, id) {
    // Optimistic: drop the row immediately (snapshot for rollback), then persist.
    const snapshot = get().tasks[id] ?? null;
    set((s) => ({ tasks: remove(s.tasks, id) }));
    try {
      await api.deleteTask(client, id);
      set({ lastError: null, lastErrorDetail: null });
      return true;
    } catch (e) {
      set((s) => ({
        tasks: snapshot ? upsert(s.tasks, snapshot) : s.tasks,
        ...errState(e),
      }));
      return false;
    }
  },

  detachTask(id) {
    const snapshot = get().tasks[id] ?? null;
    if (snapshot) set((s) => ({ tasks: remove(s.tasks, id) }));
    return snapshot;
  },

  attachTask(t) {
    if (t) set((s) => ({ tasks: upsert(s.tasks, t) }));
  },

  async commitDelete(client, id) {
    try {
      await api.deleteTask(client, id);
      set({ lastError: null, lastErrorDetail: null });
      return true;
    } catch (e) {
      set(errState(e));
      return false;
    }
  },

  reportError(e) {
    set(errState(e));
  },

  clearError() {
    set({ lastError: null, lastErrorDetail: null });
  },
}));
