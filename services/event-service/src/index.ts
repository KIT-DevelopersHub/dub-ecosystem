// Worker entrypoint. Wires the runtime env (D1, Service Bindings, Queues) into
// AppDeps and serves the Hono app. A Cron Trigger drains the free-tier @dub/freeq
// outbox (replacement for the paid EVT_* / AUDIT_QUEUE producers). This file must
// stay import-clean for `wrangler dev`.
import type { ExecutionContext, Queue, ScheduledController } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { createEvent, publishEvent, publishAudit, type AuditRecordEnvelopeV1, type DubEventEnvelope } from "@dub/events";
import { common, type auditLog } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1EventRepo } from "./d1-repo";
import { buildTaskClient } from "./task-client";
import { runOutboxDrain } from "./drain";
import { AUDIT_TOPIC, buildPublisherEnv, outboxQueue } from "./outbox";
import type { Env } from "./env";
import type { AppDeps, EventPublisher, AuditSink } from "./types";

export type { Env } from "./env";

function buildPublisher(env: Env): EventPublisher {
  // Prefer real (paid) Queue bindings when present; otherwise fan out into the
  // free-tier @dub/freeq D1 outbox so no subscriber's event is dropped.
  const pubEnv = buildPublisherEnv(env.DB, env as unknown as Partial<Record<string, Queue<DubEventEnvelope>>>);
  return {
    async publish(name, payload, ctx) {
      const envelope = createEvent(name, payload, ctx);
      await publishEvent(pubEnv, envelope);
    },
  };
}

function buildAudit(env: Env): AuditSink {
  // Real AUDIT_QUEUE when present, else the freeq outbox — audit is now always
  // durably persisted (never silently dropped when the queue binding is absent).
  const auditQueue = (env.AUDIT_QUEUE ?? outboxQueue<AuditRecordEnvelopeV1>(env.DB, AUDIT_TOPIC)) as Queue<AuditRecordEnvelopeV1>;
  return {
    async record(input: auditLog.AuditRecordInput) {
      await publishAudit({ AUDIT_QUEUE: auditQueue }, input);
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
    taskClient: buildTaskClient(env.SVC_TASK),
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

  // Free-tier Cron drain: forward audit rows to audit-log, defer domain events
  // (kept durable/pending). On a paid deploy with real Queues this is a harmless
  // no-op tick (the outbox stays empty). Best-effort: a drain hiccup is logged, not
  // thrown, so it never trips the scheduled invocation into a retry storm.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const result = await runOutboxDrain(env);
      consoleSink({ level: "info", message: "event-service outbox drained", service: "event-service", fields: { ...result } });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "event-service outbox drain failed",
        service: "event-service",
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  },
};

export { createApp } from "./app";
export { EventService } from "./service";
export { createD1EventRepo } from "./d1-repo";
export { InMemoryEventRepo } from "./memory-repo";
export { EVENT_SCHEMA_MIGRATION } from "./schema";
export type { AppDeps } from "./types";
