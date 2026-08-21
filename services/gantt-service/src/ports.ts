// Ports = the seams that make routes testable without faking D1/KV/Fetcher.
// Production factories (defaultDeps) wire the real @dub/* implementations.
import type { RequestContext } from "@dub/http";
import type { task, gantt, common } from "@dub/types";
import type { AuthClient } from "@dub/auth-client";
import type { Env } from "./env";

export interface UpstreamPort {
  /** Non-archived tasks for an event (pagination followed). */
  listTasks(ctx: RequestContext, eventId: common.EventId): Promise<task.Task[]>;
  /** Dependency edges for an event (task-service is sole owner). */
  listDependencies(ctx: RequestContext, eventId: common.EventId): Promise<task.TaskDependency[]>;
  /** Arrow-less cross-team links for an event (送る・受け取る). NOT dependencies — used
   *  only to project a role badge onto rows; never drawn as an arrow / fed to CPM. */
  listCrossLinks(ctx: RequestContext, eventId: common.EventId): Promise<task.TaskCrossLink[]>;
  /** Existence / visibility check (404 + org-boundary transparency). */
  eventExists(ctx: RequestContext, eventId: common.EventId): Promise<boolean>;
  /** Persist a row's window by writing the underlying task's startAt/dueAt (PATCH
   *  /gantt/rows). Read-modify-write against task-service (optimistic version read
   *  then patch); task-service enforces task:write on the propagated principal. */
  updateTaskDates(
    ctx: RequestContext,
    taskId: common.TaskId,
    dates: { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
  ): Promise<task.Task>;
}

export interface ViewRepo {
  get(userId: common.UserId, eventId: common.EventId): Promise<gantt.GanttViewState>;
  put(userId: common.UserId, eventId: common.EventId, req: gantt.PutGanttViewRequest): Promise<gantt.GanttViewState>;
  deleteByEvent(eventId: common.EventId): Promise<void>;
}

export interface DtoCache {
  get(eventId: common.EventId): Promise<gantt.GanttChartDTO | null>;
  put(eventId: common.EventId, dto: gantt.GanttChartDTO): Promise<void>;
  purge(eventId: common.EventId): Promise<void>;
}

export interface AppDeps {
  upstream: (env: Env) => UpstreamPort;
  views: (env: Env) => ViewRepo;
  cache: (env: Env) => DtoCache;
  authClient: (env: Env) => AuthClient;
}
