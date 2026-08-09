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
  /** Existence / visibility check (404 + org-boundary transparency). */
  eventExists(ctx: RequestContext, eventId: common.EventId): Promise<boolean>;
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
