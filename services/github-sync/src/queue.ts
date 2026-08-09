// Queue consumers: wh-github (raw GitHub webhooks) + evt-github-sync (task/event
// domain events). Both dedup on envelope.id via the shared ProcessedEventStore
// (the frozen "every handler is idempotent on envelope.id" rule).
import { createQueueHandler, type DubEventEnvelope, type WebhookEventEnvelopeV1 } from "@dub/events";
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

/** wh-github consumer. */
export async function handleWebhookBatch(batch: MessageBatch<WebhookEventEnvelopeV1>, deps: QueueDeps): Promise<void> {
  for (const message of batch.messages) {
    const env = message.body;
    try {
      if (!env || env.source !== "github" || typeof env.id !== "string") {
        message.ack();
        continue;
      }
      if (await deps.processed.wasProcessed(env.id)) {
        message.ack();
        continue;
      }
      if (!isIssueEventKind(env.eventKind)) {
        await deps.processed.markProcessed(env.id);
        message.ack();
        continue;
      }
      const payload = await resolvePayload(env, deps.webhookRaw);
      const parsed = parseIssueEvent(payload);
      if (parsed) {
        await deps.engine.applyWebhook(env.requestId, parsed);
      }
      await deps.processed.markProcessed(env.id);
      message.ack();
    } catch (err) {
      deps.log?.("webhook handler error", { id: env?.id, code: isDubError(err) ? err.code : undefined });
      message.retry();
    }
  }
}

/** evt-github-sync consumer (built on @dub/events createQueueHandler for idempotency + ack/retry). */
export function buildDomainEventHandler(deps: QueueDeps): (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> {
  return createQueueHandler(
    {
      "task.created": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
      "task.updated": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
      "task.assigned": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
      "task.status_changed": async (e) => void (await deps.engine.applyTaskUpsert(e.requestId, e.actorId, e.payload.taskId)),
      "task.archived": async (e) => void (await deps.engine.applyTaskArchived(e.requestId, e.actorId, e.payload.taskId)),
      "event.archived": async (e) => void (await deps.engine.applyEventArchived(e.payload.eventId)),
    },
    {
      idempotency: deps.processed,
      onUnknownEvent: "ack",
      onUnknownLog: (name) => deps.log?.("unknown domain event", { name }),
    },
  );
}
