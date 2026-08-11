// Worker entrypoint. Wires the runtime env (D1, Service Bindings, Queues, and the
// CHAT_ROOM Durable Object) into AppDeps and serves the Hono app; also routes the
// /ws upgrade straight to the channel's ChatRoom DO. A Cron Trigger drains the free-
// tier @dub/freeq outbox (replacement for the paid EVT_NOTIFICATION / AUDIT_QUEUE
// producers). The ChatRoom DO (RT hub) is preserved — SQLite-backed DOs run on the
// free plan. This file stays import-clean for `wrangler dev`.
import type { Fetcher, Queue, ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { createServiceClient, type RequestContext } from "@dub/http";
import { isDubError } from "@dub/errors";
import { createEvent, publishEvent, publishAudit, type AuditRecordEnvelopeV1, type DubEventEnvelope } from "@dub/events";
import { common, type auditLog } from "@dub/types";
import { consoleSink } from "@dub/observability";
import { createApp } from "./app";
import { createD1ChatRepo } from "./d1-repo";
import { NoopRealtimePublisher, DoRealtimePublisher } from "./realtime";
import { AUDIT_TOPIC, buildPublisherEnv, outboxQueue } from "./outbox";
import type { Env } from "./env";
import type { AppDeps, EventPublisher, AuditSink, EventClient, FileClient, RealtimePublisher } from "./types";

export type { Env } from "./env";

const DEFAULT_DO_URL_BASE = "wss://chat-rt.developershub.jp/ws/:id";
// Dev-only fallback secret; production sets WS_TICKET_SECRET via wrangler secret.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";

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

function buildRealtime(env: Env): RealtimePublisher {
  // Real DO fanout when the CHAT_ROOM namespace is bound; Noop otherwise so the
  // HTTP master runs unchanged in local/preview without a DO.
  return env.CHAT_ROOM ? new DoRealtimePublisher(env.CHAT_ROOM) : new NoopRealtimePublisher();
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
    realtime: buildRealtime(env),
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

// WS is gateway-bypassing / DO-direct: the ws-ticket `doUrl` points at `/ws/:id`.
// Here (co-hosted P0 entry) we route the upgrade straight to the channel's ChatRoom
// DO, which is the sole verifier (ticket + Origin). Production may split this into a
// dedicated `chat-rt` Worker via a cross-script CHAT_ROOM binding — the DO class and
// contract are unchanged.
function routeWebSocket(request: Request, env: Env, url: URL): Response {
  if (!env.CHAT_ROOM) return new Response("realtime unavailable", { status: 503 });
  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) return new Response("not found", { status: 404 });
  const channelId = decodeURIComponent(match[1]!);
  const stub = env.CHAT_ROOM.getByName(channelId);
  return stub.fetch(request as unknown as Request) as unknown as Response;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return routeWebSocket(request, env, url);
    }
    const requestId = request.headers.get("x-dub-request-id") ?? undefined;
    const app = createApp(buildDeps(env, requestId));
    return app.fetch(request as unknown as Request) as unknown as Response;
  },

  // NOTE: no scheduled() drain here. The freeq outbox is drained centrally by the
  // standalone freeq-drain worker (single aggregated cron). src/drain.ts is retained as
  // the topic->destination contract source for freeq-drain's routing map.
};

export { ChatRoom } from "./chat-room-do";
export { createApp } from "./app";
export { ChatService } from "./service";
export { createD1ChatRepo } from "./d1-repo";
export { InMemoryChatRepo } from "./memory-repo";
export { NoopRealtimePublisher, DoRealtimePublisher } from "./realtime";
export { CHAT_SCHEMA_MIGRATION } from "./schema";
export { signWsTicket, verifyWsTicket, ticketExpiryMs } from "./wsticket";
export type { AppDeps } from "./types";
