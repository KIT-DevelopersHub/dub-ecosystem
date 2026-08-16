// Domain-event queue consumer (dub-q-evt-notification / EVT_NOTIFICATION).
// Lane A: subscribed domain events → EventMappingRule → ingest.
// Lane B: notification.requested → ingest (payload IS the request).
// Infra dedup by envelope.id via the D1 IdempotencyStore (design test #12).
import type { MessageBatch } from "@cloudflare/workers-types";
import {
  createQueueHandler,
  type DubEventEnvelope,
  type DubEventHandlerMap,
  type DubEventName,
  type NotificationRequestedPayload,
} from "@dub/events";
import { consoleSink } from "@dub/observability";
import type { RequestContext } from "@dub/http";
import type { Env } from "./env";
import { SERVICE_NAME } from "./config";
import { buildDb, buildIngestDeps } from "./deps";
import { makeIdempotencyStore } from "./idempotency";
import { EVENT_MAPPINGS } from "./mapping";
import { ingest } from "./ingest";
import type { EventMappingRule, IngestInput } from "./types";

function queueCtx(requestId: string): RequestContext {
  return { requestId, caller: SERVICE_NAME };
}

/** Convert a lane-A envelope into a normalized IngestInput via its mapping rule. */
export function mappingToIngest(rule: EventMappingRule, env: DubEventEnvelope): IngestInput {
  const content = rule.buildContent(env.payload);
  return {
    type: rule.type,
    recipients: rule.buildRecipients(env.payload),
    title: content.title,
    body: content.body ?? null,
    priority: rule.priority,
    ...(rule.audience ? { audience: rule.audience } : {}),
    channels: rule.channels,
    dedupKey: rule.buildDedupKey?.(env.payload),
    resourceType: content.resourceType ?? null,
    resourceId: content.resourceId ?? null,
    source: "queue",
    sourceEvent: env.name,
    actorId: env.actorId,
    requestId: env.requestId,
  };
}

/** Lane-B: notification.requested payload → IngestInput. */
export function requestedToIngest(env: DubEventEnvelope<"notification.requested">): IngestInput {
  const p = env.payload as NotificationRequestedPayload;
  return {
    type: p.type,
    recipients: { userIds: p.recipientIds },
    title: p.title,
    body: p.body ?? null,
    priority: "normal",
    source: "queue",
    sourceEvent: "notification.requested",
    actorId: env.actorId,
    requestId: env.requestId,
  };
}

export function buildHandlers(env: Env): DubEventHandlerMap {
  const handlers: Record<string, (e: DubEventEnvelope, c: { requestId: string }) => Promise<void>> = {};

  for (const name of Object.keys(EVENT_MAPPINGS) as DubEventName[]) {
    const rule = EVENT_MAPPINGS[name];
    if (!rule) continue;
    handlers[name] = async (e, c) => {
      const deps = buildIngestDeps(env, queueCtx(c.requestId));
      await ingest(deps, mappingToIngest(rule, e));
    };
  }

  handlers["notification.requested"] = async (e, c) => {
    const deps = buildIngestDeps(env, queueCtx(c.requestId));
    await ingest(deps, requestedToIngest(e as DubEventEnvelope<"notification.requested">));
  };

  return handlers as DubEventHandlerMap;
}

/** Batch entry point wired from the Worker's queue() export. */
export async function consumeEventQueue(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
  const idempotency = makeIdempotencyStore(buildDb(env, "queue"));
  const handler = createQueueHandler(buildHandlers(env), {
    idempotency,
    onUnknownEvent: "ack", // △pending chat.*/mail.* land here in P0 (no-op ack)
    onUnknownLog: (name) =>
      consoleSink({ level: "debug", message: "notification: unmapped event acked", service: SERVICE_NAME, fields: { name } }),
  });
  await handler(batch, env);
}
