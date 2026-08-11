// Queue consumers: wh-github (raw GitHub webhooks) + evt-github-sync (task/event
// domain events). Both dedup on envelope.id via the shared ProcessedEventStore
// (the frozen "every handler is idempotent on envelope.id" rule).
//
// On the Workers FREE plan there is no Queue consumer for either inbound lane. The SAME
// handler logic is reached over HTTP via the /internal/webhooks-async and
// /internal/events-async landing routes (see app.ts): webhook-ingest / task-service /
// event-service forward each due envelope from their own @dub/freeq D1 outbox drains.
// dispatchWebhook / dispatchDomainEvent are the single-envelope paths shared by those
// routes, so the sync logic lives in exactly one place regardless of transport, and the
// envelope.id idempotency is identical (safe under at-least-once redelivery).
import {
  createQueueHandler,
  type DubEventEnvelope,
  type DubEventHandlerMap,
  type WebhookEventEnvelopeV1,
} from "@dub/events";
import type { MessageBatch, R2Bucket } from "@cloudflare/workers-types";
import { isDubError } from "@dub/errors";
import type { SyncEngine } from "./engine/sync";
import type { ProcessedEventStore } from "./store/types";
import { parseIssueEvent, isIssueEventKind } from "./engine/parse";

export interface QueueDeps {
  engine: SyncEngine;
  processed: ProcessedEventStore;
  webhookRaw: R2Bucket;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Resolve the webhook payload, pulling from R2 when the envelope offloaded it (>96KB). */
export async function resolvePayload(env: WebhookEventEnvelopeV1, r2: R2Bucket): Promise<unknown> {
  if (env.payload !== null && env.payload !== undefined) return env.payload;
  if (!env.r2Key) return null;
  const obj = await r2.get(env.r2Key);
  if (!obj) return null;
  const text = await obj.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Process one raw-webhook envelope with envelope.id idempotency. Shared by the wh-github
 * Queue consumer and the free-tier /internal/webhooks-async landing route. THROWS on a
 * transient failure so the caller (Queue retry / drain non-2xx) retries and never loses
 * the event; a malformed / already-processed / non-issue envelope is a no-op.
 */
export async function dispatchWebhook(deps: QueueDeps, env: WebhookEventEnvelopeV1): Promise<void> {
  if (!env || env.source !== "github" || typeof env.id !== "string") return;
  if (await deps.processed.wasProcessed(env.id)) return;
  if (!isIssueEventKind(env.eventKind)) {
    await deps.processed.markProcessed(env.id);
    return;
  }
  const payload = await resolvePayload(env, deps.webhookRaw);
  const parsed = parseIssueEvent(payload);
  if (parsed) {
    await deps.engine.applyWebhook(env.requestId, parsed);
  }
  await deps.processed.markProcessed(env.id);
}

/** wh-github consumer. */
export async function handleWebhookBatch(batch: MessageBatch<WebhookEventEnvelopeV1>, deps: QueueDeps): Promise<void> {
  for (const message of batch.messages) {
    const env = message.body;
    try {
      await dispatchWebhook(deps, env);
      message.ack();
    } catch (err) {
      deps.log?.("webhook handler error", { id: env?.id, code: isDubError(err) ? err.code : undefined });
      message.retry();
    }
  }
}

/** Domain-event handlers (transport-agnostic: shared by the Queue consumer and the free-tier route). */
export function domainEventHandlers(deps: QueueDeps): DubEventHandlerMap {
  return {
    "task.created": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
    "task.updated": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
    "task.assigned": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
    "task.status_changed": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
    "task.archived": async (e) => void (await deps.engine.applyTaskArchived(e.requestId, e.actorId, e.payload.taskId)),
    "event.archived": async (e) => void (await deps.engine.applyEventArchived(e.payload.eventId)),
  };
}

/** evt-github-sync consumer (built on @dub/events createQueueHandler for idempotency + ack/retry). */
export function buildDomainEventHandler(deps: QueueDeps): (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> {
  return createQueueHandler(domainEventHandlers(deps), {
    idempotency: deps.processed,
    onUnknownEvent: "ack",
    onUnknownLog: (name) => deps.log?.("unknown domain event", { name }),
  });
}

/**
 * Deliver a single domain-event envelope through the same handlers + envelope.id
 * idempotency the Queue consumer uses. Shared by the free-tier /internal/events-async
 * landing route. Unknown event names are a no-op (acked), exactly like the Queue path
 * (onUnknownEvent: "ack"). Dedup on envelope.id, then mark processed after the handler
 * succeeds, so a failed delivery is safely retried by the caller's drain. THROWS on a
 * handler failure so the caller keeps the row pending and retries (event never lost).
 */
export async function dispatchDomainEvent(deps: QueueDeps, envelope: DubEventEnvelope): Promise<void> {
  if (await deps.processed.wasProcessed(envelope.id)) return;
  const handler = (domainEventHandlers(deps) as Record<
    string,
    ((e: DubEventEnvelope, c: { requestId: string }) => Promise<void>) | undefined
  >)[envelope.name];
  if (handler) await handler(envelope, { requestId: envelope.requestId });
  await deps.processed.markProcessed(envelope.id);
}
