// Worker entrypoint: HTTP (Hono internal API) + Queue consumer
// (dub-q-evt-mail-automation -> mail.message.received). mail-gateway/notification
// queues are STUB until the integration wave; this module only wires bindings.
import type { D1Database, Fetcher, Queue, MessageBatch, ExecutionContext } from "@cloudflare/workers-types";
import { createDbClient, newId, nowIso } from "@dub/db";
import { common } from "@dub/types";
import { createServiceClient, type RequestContext } from "@dub/http";
import {
  createQueueHandler,
  type DubEventEnvelope,
  type IdempotencyStore,
} from "@dub/events";
import { createApp } from "./app";
import { createMailGatewayClient } from "./gateway";
import { createEventPublisher, createAuditSink } from "./publisher";
import { createD1Repo, type MailAutoRepo } from "./repo";
import { processInbound, type EventInfoClient, type PipelineDeps } from "./pipeline";
import { createAuthClient } from "@dub/auth-client";

export interface Env {
  DB: D1Database;
  SVC_MAIL_GATEWAY: Fetcher;
  SVC_IDENTITY: Fetcher;
  SVC_EVENT?: Fetcher;
  EVT_NOTIFICATION: Queue<DubEventEnvelope>;
  AUDIT_QUEUE: Queue<never>;
  SELF_DOMAINS?: string; // comma-separated (α default: developershub.jp)
  SELF_ADDRESSES?: string; // comma-separated
}

function splitCsv(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function eventClientOf(env: Env): EventInfoClient | undefined {
  if (!env.SVC_EVENT) return undefined;
  const client = createServiceClient(env.SVC_EVENT, { service: "event-service", caller: "mail-automation" });
  return {
    async getEvent(ctx: RequestContext, id: string) {
      return client.get<{ title: string } | null>(ctx, `/events/${encodeURIComponent(id)}`);
    },
  };
}

function buildPipeline(env: Env, repo: MailAutoRepo): PipelineDeps {
  const eventClient = eventClientOf(env);
  return {
    repo,
    gateway: createMailGatewayClient(env.SVC_MAIL_GATEWAY),
    publisher: createEventPublisher({ EVT_NOTIFICATION: env.EVT_NOTIFICATION }),
    audit: createAuditSink({ AUDIT_QUEUE: env.AUDIT_QUEUE }),
    ...(eventClient ? { eventClient } : {}),
    now: nowIso,
    mintDecisionId: () => newId("mailauto_dec"),
    selfDomains: splitCsv(env.SELF_DOMAINS, ["developershub.jp"]),
    selfAddresses: splitCsv(env.SELF_ADDRESSES, []),
    orgId: common.DUB_DEFAULT_ORG_ID,
  };
}

function repoOf(env: Env): MailAutoRepo {
  return createD1Repo(createDbClient(env.DB, { namespace: "mailauto" }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const repo = repoOf(env);
    const authClient = createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: "mail-automation" });
    const app = createApp({ pipeline: buildPipeline(env, repo), authClient });
    return app.fetch(request);
  },

  async queue(batch: MessageBatch<DubEventEnvelope>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const repo = repoOf(env);
    const pipeline = buildPipeline(env, repo);
    const idempotency: IdempotencyStore = {
      wasProcessed: (id) => repo.wasEventProcessed(id),
      markProcessed: (id) => repo.markEventProcessed(id),
    };
    const handler = createQueueHandler(
      {
        "mail.message.received": async (event, { requestId }) => {
          const { messageId } = event.payload;
          const ctx: RequestContext = { requestId };
          const full = await pipeline.gateway.getMessage(ctx, messageId);
          await processInbound(pipeline, full, {}, { requestId, actorId: event.actorId });
        },
      },
      { idempotency },
    );
    await handler(batch, env);
  },
};
