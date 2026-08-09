// Zustand store: thin reactive wrapper over the pure task-store reducer. Holds
// the shared task cache for all three views + the optimistic mutation actions.
// The pure logic lives in domain/task-store (tested there); this adds reactivity
// and API wiring only.
import { create } from "zustand";
import type { task, common } from "@dub/types";
import type { ApiClient } from "../contracts/spa-shell";
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
  lastError: ErrorUx | null;
  // queries
  list: () => task.Task[];
  column: (status: task.TaskStatus) => task.Task[];
  // loads
  load: (client: ApiClient, q: task.ListTasksQuery) => Promise<void>;
  loadMore: (client: ApiClient, q: task.ListTasksQuery) => Promise<void>;
  // optimistic mutation (board D&D / gantt bar D&D / inline edit)
  patchOptimistic: (
    client: ApiClient,
    id: common.TaskId,
    patch: OptimisticPatch["changes"],
    version: number,
    body: task.UpdateTaskRequest,
  ) => Promise<task.Task | null>;
  // non-optimistic (create / delete after confirm)
  create: (client: ApiClient, body: task.CreateTaskRequest) => Promise<task.Task | null>;
  removeTask: (client: ApiClient, id: common.TaskId) => Promise<boolean>;
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: {},
  nextCursor: null,
  lastError: null,

  list: () => toList(get().tasks),
  column: (status) => byStatus(get().tasks, status),

  async load(client, q) {
    try {
      const res = await api.listTasks(client, q);
      set({ tasks: indexTasks(res.items), nextCursor: res.nextCursor, lastError: null });
    } catch (e) {
      set({ lastError: mapError(toDisplayableError(e)) });
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
      set({ lastError: mapError(toDisplayableError(e)) });
    }
  },

  async patchOptimistic(client, id, changes, _version, body) {
    const [optimistic, snapshot] = applyOptimistic(get().tasks, { id, changes });
    set({ tasks: optimistic });
    try {
      const server = await api.updateTask(client, id, body);
      set((s) => ({ tasks: confirm(s.tasks, server), lastError: null }));
      return server;
    } catch (e) {
      set((s) => ({ tasks: rollback(s.tasks, snapshot), lastError: mapError(toDisplayableError(e)) }));
      return null;
    }
  },

  async create(client, body) {
    try {
      const server = await api.createTask(client, body);
      set((s) => ({ tasks: upsert(s.tasks, server), lastError: null }));
      return server;
    } catch (e) {
      set({ lastError: mapError(toDisplayableError(e)) });
      return null;
    }
  },

  async removeTask(client, id) {
    try {
      await api.deleteTask(client, id);
      set((s) => ({ tasks: remove(s.tasks, id), lastError: null }));
      return true;
    } catch (e) {
      set({ lastError: mapError(toDisplayableError(e)) });
      return false;
    }
  },
}));
