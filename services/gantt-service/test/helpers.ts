import { DubError, CommonErrorCodes } from "@dub/errors";
import type { MiddlewareHandler } from "hono";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { task, gantt, common } from "@dub/types";
import type { UpstreamPort, ViewRepo, DtoCache } from "../src/ports";

export function mkTask(over: Partial<task.Task> & { id: string }): task.Task {
  return {
    id: over.id,
    eventId: over.eventId ?? "event_1",
    title: over.title ?? over.id,
    description: null,
    status: over.status ?? "todo",
    priority: "medium",
    assigneeId: over.assigneeId ?? null,
    dueAt: over.dueAt ?? null,
    origin: "internal",
    archivedAt: over.archivedAt ?? null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    version: 1,
  };
}

export function fakeAuthClient(opts: { allow: boolean }): AuthClient {
  const requireAuth = (): MiddlewareHandler => async (c, next) => {
    const userId = c.req.header("x-dub-user-id");
    if (!userId) throw new DubError(CommonErrorCodes.UNAUTHENTICATED, "no user", { status: 401 });
    const authn: AuthnContext = { userId, source: "trusted_header", session: null };
    c.set("authn", authn);
    await next();
  };
  const requirePermission = (): MiddlewareHandler => async (c, next) => {
    if (!opts.allow) throw new DubError(CommonErrorCodes.FORBIDDEN, "denied", { status: 403 });
    await next();
  };
  return {
    requireAuth,
    requirePermission,
    verify: async () => {
      throw new Error("unused");
    },
    checkPermissions: async () => ({ decisions: [] }),
    hasPermission: async () => opts.allow,
    invalidateAuthzCache: () => {},
  };
}

export function fakeUpstream(init: {
  tasks?: task.Task[];
  dependencies?: task.TaskDependency[];
  eventExists?: boolean;
}): UpstreamPort & { calls: { listTasks: number } } {
  const state = { calls: { listTasks: 0 } };
  return {
    calls: state.calls,
    async listTasks() {
      state.calls.listTasks++;
      return init.tasks ?? [];
    },
    async listDependencies() {
      return init.dependencies ?? [];
    },
    async eventExists() {
      return init.eventExists ?? true;
    },
  };
}

export function fakeViewRepo(): ViewRepo {
  const store = new Map<string, gantt.GanttViewState>();
  const key = (u: string, e: string) => `${u}|${e}`;
  return {
    async get(userId, eventId) {
      return store.get(key(userId, eventId)) ?? { eventId, zoom: "week", collapsedTaskIds: [] };
    },
    async put(userId, eventId, req) {
      const state: gantt.GanttViewState = { eventId, zoom: req.zoom, collapsedTaskIds: req.collapsedTaskIds };
      store.set(key(userId, eventId), state);
      return state;
    },
    async deleteByEvent(eventId) {
      for (const k of [...store.keys()]) if (k.endsWith(`|${eventId}`)) store.delete(k);
    },
  };
}

export function fakeCache(): DtoCache & { puts: string[]; purges: string[] } {
  const store = new Map<common.EventId, gantt.GanttChartDTO>();
  const puts: string[] = [];
  const purges: string[] = [];
  return {
    puts,
    purges,
    async get(eventId) {
      return store.get(eventId) ?? null;
    },
    async put(eventId, dto) {
      puts.push(eventId);
      store.set(eventId, dto);
    },
    async purge(eventId) {
      purges.push(eventId);
      store.delete(eventId);
    },
  };
}
