// Ports = the seams that make routes testable without faking D1/KV/Fetcher.
// Production factories (defaultDeps) wire the real @dub/* implementations.
import type { RequestContext } from "@dub/http";
import type { task, gantt, common } from "@dub/types";
import type { AuthClient } from "@dub/auth-client";
import type { Env } from "./env";
import type { RealtimePublisher } from "./realtime";

export interface UpstreamPort {
  /** Non-archived tasks for an event (pagination followed). */
  listTasks(ctx: RequestContext, eventId: common.EventId): Promise<task.Task[]>;
  /** Dependency edges for an event (task-service is sole owner). */
  listDependencies(ctx: RequestContext, eventId: common.EventId): Promise<task.TaskDependency[]>;
  /** Existence / visibility check (404 + org-boundary transparency). */
  eventExists(ctx: RequestContext, eventId: common.EventId): Promise<boolean>;
  /**
   * Persist a row's window by writing the underlying task's startAt/dueAt (PATCH
   * /gantt/rows). Read-modify-write against task-service (optimistic version read then
   * patch); task-service enforces its own policy table on the propagated principal.
   *
   * `assertWritable` is the INSTANCE-LAYER authorization hook, awaited with the freshly-read
   * task BEFORE the patch — that ordering is the whole point. The route is task-scoped, so
   * the request names no event and the policy table cannot judge which event the write lands
   * in; only the loaded row knows (`task.eventId`). Passing the assertion in here, rather
   * than re-reading the task in the handler, closes inventory a-4 with no extra subrequest
   * while keeping the policy decision in app.ts with the rest of it. It runs on every attempt
   * of the version-conflict retry (identity decisions are cached, so this is cheap).
   */
  updateTaskDates(
    ctx: RequestContext,
    taskId: common.TaskId,
    dates: { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
    assertWritable: (current: task.Task) => Promise<void>,
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
  // Realtime fanout (DO + WS). A seam so tests inject a fake publisher; production wires
  // the real DO-backed one (Noop when no GANTT_ROOM binding exists).
  realtime: (env: Env) => RealtimePublisher;
}
