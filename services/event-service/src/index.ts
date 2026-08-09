// Worker entrypoint. Wires the runtime env (D1, Service Bindings, Queues) into
// AppDeps and serves the Hono app. Deploy is out of scope for this unit (wrangler
// config is a skeleton); this file must stay import-clean for `wrangler dev`.
import type { D1Database, Fetcher, Queue, ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { createServiceClient, type RequestContext } from "@dub/http";
import { createEvent, publishEvent, publishAudit, type AuditRecordEnvelopeV1, type DubEventPublisherEnv } from "@dub/events";
import { common, type task, type auditLog } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1EventRepo } from "./d1-repo";
import type { AppDeps, EventPublisher, AuditSink, TaskClient } from "./types";

export interface Env {
  DB: D1Database;
  SVC_IDENTITY: Fetcher;
  SVC_TASK?: Fetcher;
  // event fan-out queues (only the ones event.* / action.* target need to exist)
  EVT_NOTIFICATION?: Queue;
  EVT_TASK?: Queue;
  EVT_GANTT?: Queue;
  EVT_FILE_META?: Queue;
  EVT_GITHUB_SYNC?: Queue;
  EVT_MOBILE_BFF?: Queue;
  AUDIT_QUEUE?: Queue;
  DUB_DEFAULT_ORG_ID?: string;
}

function buildPublisher(env: Env): EventPublisher {
  return {
    async publish(name, payload, ctx) {
      const envelope = createEvent(name, payload, ctx);
      // publishEvent fans out to subscriber queues; missing bindings for a
      // subscriber throw (fail-loud). Unsubscribed events are a no-op.
      await publishEvent(env as unknown as DubEventPublisherEnv, envelope);
    },
  };
}

function buildAudit(env: Env): AuditSink {
  return {
    async record(input: auditLog.AuditRecordInput) {
      if (!env.AUDIT_QUEUE) return; // audit queue optional in local/preview
      await publishAudit({ AUDIT_QUEUE: env.AUDIT_QUEUE as Queue<AuditRecordEnvelopeV1> }, input);
    },
  };
}

function buildTaskClient(env: Env): TaskClient {
  return {
    async listAssigneeIds(ctx, eventId) {
      if (!env.SVC_TASK) return [];
      const client = createServiceClient(env.SVC_TASK, { service: "task-service", caller: "event-service" });
      const rc: RequestContext = { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
      const res = await client.get<task.ListTasksResponse>(rc, "/tasks", { query: { eventId, limit: 200 } });
      const ids = new Set<string>();
      for (const t of res.items) if (t.assigneeId) ids.add(t.assigneeId);
      return [...ids];
    },
  };
}

export function buildDeps(env: Env, requestId?: string): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "event",
    ...(requestId ? { requestId } : {}),
    logger: (e) => consoleSink({ level: "debug", message: "db", service: "event-service", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  const authz = createAuthClient({
    identityBinding: env.SVC_IDENTITY,
    serviceName: "event-service",
    mode: "trustedHeader",
  });
  return {
    repo: createD1EventRepo(db),
    authz,
    publisher: buildPublisher(env),
    audit: buildAudit(env),
    taskClient: buildTaskClient(env),
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    now: nowIso,
    newEventId: () => newId("event"),
    newActionId: () => newId("action"),
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },
};

export { createApp } from "./app";
export { EventService } from "./service";
export { createD1EventRepo } from "./d1-repo";
export { InMemoryEventRepo } from "./memory-repo";
export { EVENT_SCHEMA_MIGRATION } from "./schema";
export type { AppDeps } from "./types";
