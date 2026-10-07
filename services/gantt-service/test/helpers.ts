import { DubError, CommonErrorCodes } from "@dub/errors";
import type { MiddlewareHandler } from "hono";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { task, gantt, common } from "@dub/types";
import type { UpstreamPort, ViewRepo, DtoCache } from "../src/ports";
import type { RealtimePublisher } from "../src/realtime";

export function mkTask(over: Partial<task.Task> & { id: string }): task.Task {
  return {
    id: over.id,
    // `?? "event_1"` would swallow an explicit null, and "unlinked task" (eventId === null) is
    // a case the event-scope assertion has to be tested against — so honour it.
    eventId: "eventId" in over ? over.eventId! : "event_1",
    title: over.title ?? over.id,
    description: null,
    status: over.status ?? "todo",
    priority: "medium",
    assigneeId: over.assigneeId ?? null,
    startAt: over.startAt ?? null,
    dueAt: over.dueAt ?? null,
    origin: "internal",
    archivedAt: over.archivedAt ?? null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    version: 1,
  };
}

/**
 * Fake identity client with the TWO axes the policy layers ask about separately:
 *
 *   `allow`      the UNSCOPED key question — what `policyGate` asks through its
 *                `PermissionGranter` (does the caller hold app:gantt:view / event:read at all).
 *   `eventScope` the RESOURCE-SCOPED question — what `assertEventScope` asks in the handler
 *                (does that event:read apply to THIS event). Defaults to `allow`.
 *
 * Keeping them independent is what lets a test express the case inventory a-4 is about: keys
 * held, event not readable. One combined switch could not say that, which is precisely why
 * the bypass went unnoticed.
 */
export function fakeAuthClient(opts: { allow: boolean; eventScope?: boolean }): AuthClient {
  const scoped = opts.eventScope ?? opts.allow;
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
  const decision = (allowed: boolean) => ({
    allowed,
    evaluatedAt: "2026-08-01T00:00:00.000Z",
    ttlSeconds: 0,
  });
  return {
    requireAuth,
    requirePermission,
    verify: async () => {
      throw new Error("unused");
    },
    // The gate's granter goes through here: one decision per requested check, in order.
    checkPermissions: async (req) => ({
      decisions: req.checks.map((q) => decision(q.resourceId ? scoped : opts.allow)),
    }),
    hasPermission: async (_u, _o, q) => (q.resourceId ? scoped : opts.allow),
    requireAppAccess: (): MiddlewareHandler => requirePermission(),
    appAccessLevel: async () => (opts.allow ? "edit" : "none"),
    invalidateAuthzCache: () => {},
  };
}

export function fakeUpstream(init: {
  tasks?: task.Task[];
  dependencies?: task.TaskDependency[];
  eventExists?: boolean;
}): UpstreamPort & { calls: { listTasks: number; updateTaskDates: number } } {
  const state = { calls: { listTasks: 0, updateTaskDates: 0 } };
  const byId = new Map<string, task.Task>((init.tasks ?? []).map((t) => [t.id, t]));
  return {
    calls: state.calls,
    async listTasks() {
      state.calls.listTasks++;
      return [...byId.values()];
    },
    async listDependencies() {
      return init.dependencies ?? [];
    },
    async eventExists() {
      return init.eventExists ?? true;
    },
    async updateTaskDates(_ctx, taskId, dates, assertWritable) {
      const cur = byId.get(taskId);
      if (!cur) throw new DubError(CommonErrorCodes.NOT_FOUND, `task not found: ${taskId}`, { status: 404 });
      // Same order as the real upstream: read, authorize the ROW, only then write. Counting
      // the call after the assertion is what makes "403 and nothing mutated" assertable.
      await assertWritable(cur);
      state.calls.updateTaskDates++;
      const next: task.Task = {
        ...cur,
        startAt: dates.startsAt,
        dueAt: dates.endsAt,
        version: cur.version + 1,
        updatedAt: "2026-08-18T00:00:00Z",
      };
      byId.set(taskId, next);
      return next;
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

export interface FakeRealtime extends RealtimePublisher {
  moved: { eventId: string; taskId: string; startsAt: string | null; endsAt: string | null }[];
  invalidated: { eventId: string; reason: string }[];
}

/** Records realtime fanout calls so route tests can assert a delta was broadcast. */
export function fakeRealtime(): FakeRealtime {
  const moved: FakeRealtime["moved"] = [];
  const invalidated: FakeRealtime["invalidated"] = [];
  return {
    moved,
    invalidated,
    async publishRowMoved(eventId, move) {
      moved.push({ eventId, taskId: move.taskId, startsAt: move.startsAt, endsAt: move.endsAt });
    },
    async publishInvalidated(eventId, reason) {
      invalidated.push({ eventId, reason });
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
