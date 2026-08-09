// Worker entrypoint. Wires the runtime env (D1, Service Bindings, Queues) into
// AppDeps and serves the Hono app. Deploy is out of scope for this unit (wrangler
// config is a skeleton); this file stays import-clean for `wrangler dev`.
import type { D1Database, Fetcher, Queue, ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { createServiceClient, type RequestContext } from "@dub/http";
import { isDubError } from "@dub/errors";
import { createEvent, publishEvent, publishAudit, type AuditRecordEnvelopeV1, type DubEventPublisherEnv } from "@dub/events";
import { common, type auditLog } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1ChatRepo } from "./d1-repo";
import { NoopRealtimePublisher } from "./realtime";
import type { AppDeps, EventPublisher, AuditSink, EventClient, FileClient } from "./types";

export interface Env {
  DB: D1Database;
  SVC_IDENTITY: Fetcher;
  SVC_EVENT?: Fetcher;
  SVC_FILE_META?: Fetcher;
  EVT_NOTIFICATION?: Queue;
  AUDIT_QUEUE?: Queue;
  DUB_DEFAULT_ORG_ID?: string;
  CHAT_RT_DO_URL_BASE?: string;
  WS_TICKET_SECRET?: string;
}

const DEFAULT_DO_URL_BASE = "wss://chat-rt.developershub.jp/ws/:id";
// Dev-only fallback secret; production sets WS_TICKET_SECRET via wrangler secret.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";

function buildPublisher(env: Env): EventPublisher {
  return {
    async publish(name, payload, ctx) {
      const envelope = createEvent(name, payload, ctx);
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

function buildEventClient(env: Env): EventClient {
  return {
    async eventExists(ctx, eventId) {
      if (!env.SVC_EVENT) return true; // cannot verify in local/preview -> allow
      const client = createServiceClient(env.SVC_EVENT, { service: "event-service", caller: "chat-service" });
      const rc: RequestContext = { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
      try {
        await client.get(rc, `/events/${encodeURIComponent(eventId)}`);
        return true;
      } catch (err) {
        if (isDubError(err) && err.status === 404) return false;
        throw err;
      }
    },
  };
}

function buildFileClient(env: Env): FileClient {
  return {
    async registerLinks(ctx, messageId, fileIds) {
      if (!env.SVC_FILE_META || fileIds.length === 0) return;
      const client = createServiceClient(env.SVC_FILE_META, { service: "file-meta-service", caller: "chat-service" });
      const rc: RequestContext = { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
      // Best-effort in P0: a link-registration failure must not drop the message
      // (§8#3 remains open). file_meta_links is file-meta's source of truth.
      for (const fileId of fileIds) {
        try {
          await client.post(rc, `/meta/${encodeURIComponent(fileId)}/links`, { entityType: "chat_message", entityId: messageId });
        } catch (err) {
          consoleSink({ level: "warn", message: "file link registration failed", service: "chat-service", fields: { fileId, messageId, err: String(err) } });
        }
      }
    },
  };
}

export function buildDeps(env: Env, requestId?: string): AppDeps {
  const db = createDbClient(env.DB, {
    namespace: "chat",
    ...(requestId ? { requestId } : {}),
    logger: (e) => consoleSink({ level: "debug", message: "db", service: "chat-service", fields: { sql: e.sql, ms: e.durationMs } }),
  });
  const authz = createAuthClient({
    identityBinding: env.SVC_IDENTITY,
    serviceName: "chat-service",
    mode: "trustedHeader",
  });
  return {
    repo: createD1ChatRepo(db),
    authz,
    publisher: buildPublisher(env),
    audit: buildAudit(env),
    realtime: new NoopRealtimePublisher(),
    eventClient: buildEventClient(env),
    fileClient: buildFileClient(env),
    orgId: env.DUB_DEFAULT_ORG_ID ?? common.DUB_DEFAULT_ORG_ID,
    wsTicketSecret: env.WS_TICKET_SECRET ?? DEV_WS_SECRET,
    doUrlBase: env.CHAT_RT_DO_URL_BASE ?? DEFAULT_DO_URL_BASE,
    now: nowIso,
    newChannelId: () => newId("chan"),
    newMessageId: () => newId("msg"),
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
export { ChatService } from "./service";
export { createD1ChatRepo } from "./d1-repo";
export { InMemoryChatRepo } from "./memory-repo";
export { NoopRealtimePublisher } from "./realtime";
export { CHAT_SCHEMA_MIGRATION } from "./schema";
export { signWsTicket, verifyWsTicket, ticketExpiryMs } from "./wsticket";
export type { AppDeps } from "./types";
