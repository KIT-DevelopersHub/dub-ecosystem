// Producer / consumer helpers + special channels (audit, webhook).
import type { Queue, MessageBatch } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { redactSecrets } from "@dub/observability";
import type { auditLog, webhook } from "@dub/types";
import {
  type DubEventName,
  type DubEventEnvelope,
  type DubEventPayloadMap,
  type ConsumerService,
  SUBSCRIPTIONS,
  CONSUMER_QUEUE_BINDINGS,
} from "./catalog";

const MAX_MESSAGE_BYTES = 128 * 1024;
const SEND_BATCH_CHUNK = 100;

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
type RandomSource = { getRandomValues?: (a: Uint8Array) => Uint8Array };
function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    time = ENCODING[mod]! + time;
    t = (t - mod) / 32;
  }
  const g = (globalThis as { crypto?: RandomSource }).crypto;
  let rand = "";
  for (let i = 0; i < 16; i++) {
    const n = g?.getRandomValues ? (g.getRandomValues(new Uint8Array(1))[0] as number) : Math.floor(Math.random() * 256);
    rand += ENCODING[n % 32]!;
  }
  return time + rand;
}

export interface DubEventContext {
  requestId: string; // dubCtx.requestId (@dub/http)
  actorId: string | null;
  occurredAt?: string;
}

export function createEvent<N extends DubEventName>(
  name: N,
  payload: DubEventPayloadMap[N],
  ctx: DubEventContext,
): DubEventEnvelope<N> {
  return {
    name,
    version: 1,
    id: ulid(),
    occurredAt: ctx.occurredAt ?? new Date().toISOString(),
    requestId: ctx.requestId,
    actorId: ctx.actorId,
    payload,
  };
}

export type DubEventPublisherEnv = Partial<Record<string, Queue<DubEventEnvelope>>>;

function byteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

function subscribersOf(name: DubEventName): readonly ConsumerService[] {
  const subs = (SUBSCRIPTIONS as Record<string, readonly ConsumerService[]>)[name];
  if (!subs) throw new DubError("EVENTS_UNKNOWN_EVENT", `Unknown event name: ${name}`, { status: 500 });
  return subs;
}

export async function publishEvent<N extends DubEventName>(
  env: DubEventPublisherEnv,
  event: DubEventEnvelope<N>,
): Promise<void> {
  if (byteLength(event) > MAX_MESSAGE_BYTES) {
    throw new DubError("EVENTS_PAYLOAD_TOO_LARGE", `Event ${event.name} exceeds 128KB; reference by id instead`, { status: 413 });
  }
  const consumers = subscribersOf(event.name);
  for (const consumer of consumers) {
    const binding = CONSUMER_QUEUE_BINDINGS[consumer];
    const queue = env[binding];
    if (!queue) throw new DubError("EVENTS_MISSING_BINDING", `Missing queue binding ${binding} for consumer ${consumer}`, { status: 500 });
    await queue.send(event);
  }
}

export async function publishEvents(env: DubEventPublisherEnv, events: DubEventEnvelope[]): Promise<void> {
  // group by target queue binding, then sendBatch in chunks of 100
  const perQueue = new Map<string, DubEventEnvelope[]>();
  for (const event of events) {
    if (byteLength(event) > MAX_MESSAGE_BYTES) {
      throw new DubError("EVENTS_PAYLOAD_TOO_LARGE", `Event ${event.name} exceeds 128KB`, { status: 413 });
    }
    for (const consumer of subscribersOf(event.name)) {
      const binding = CONSUMER_QUEUE_BINDINGS[consumer];
      (perQueue.get(binding) ?? perQueue.set(binding, []).get(binding)!).push(event);
    }
  }
  for (const [binding, batch] of perQueue) {
    const queue = env[binding];
    if (!queue) throw new DubError("EVENTS_MISSING_BINDING", `Missing queue binding ${binding}`, { status: 500 });
    for (let i = 0; i < batch.length; i += SEND_BATCH_CHUNK) {
      const chunk = batch.slice(i, i + SEND_BATCH_CHUNK);
      await queue.sendBatch(chunk.map((body) => ({ body })));
    }
  }
}

// ---- consumer ----
export interface IdempotencyStore {
  wasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}
export type DubEventHandlerMap = {
  [N in DubEventName]?: (event: DubEventEnvelope<N>, ctx: { requestId: string }) => Promise<void>;
};
export interface QueueHandlerOptions {
  idempotency?: IdempotencyStore;
  onUnknownEvent?: "ack" | "retry"; // default "ack" (forward-compat)
  onUnknownLog?: (name: string) => void;
}

export function createQueueHandler(
  handlers: DubEventHandlerMap,
  opts: QueueHandlerOptions = {},
): (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> {
  return async (batch) => {
    for (const message of batch.messages) {
      const env = message.body;
      try {
        if (!env || typeof env.name !== "string" || typeof env.id !== "string") {
          throw new DubError("EVENTS_ENVELOPE_INVALID", "Malformed event envelope", { status: 500 });
        }
        if (opts.idempotency && (await opts.idempotency.wasProcessed(env.id))) {
          message.ack();
          continue;
        }
        const handler = (handlers as Record<string, ((e: DubEventEnvelope, c: { requestId: string }) => Promise<void>) | undefined>)[env.name];
        if (!handler) {
          opts.onUnknownLog?.(env.name);
          if ((opts.onUnknownEvent ?? "ack") === "retry") message.retry();
          else message.ack();
          continue;
        }
        await handler(env, { requestId: env.requestId });
        if (opts.idempotency) await opts.idempotency.markProcessed(env.id);
        message.ack();
      } catch {
        message.retry(); // P0: unconditional retry (max_retries exhaustion -> DLQ)
      }
    }
  };
}

// ---- special channel: audit ----
export interface AuditRecordEnvelopeV1 {
  type: "audit.record";
  version: 1;
  id: string;
  payload: auditLog.AuditRecordInput;
}
export async function publishAudit(
  env: { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> },
  input: auditLog.AuditRecordInput,
): Promise<void> {
  // built-in sanitizer: strip secret keys from details before enqueue (theme#13)
  const sanitized: auditLog.AuditRecordInput = {
    ...input,
    details: input.details ? redactSecrets(input.details) : null,
  };
  await env.AUDIT_QUEUE.send({ type: "audit.record", version: 1, id: ulid(), payload: sanitized });
}

// ---- special channel: webhook (envelope owned by webhook-ingest; re-exported) ----
export type WebhookEventEnvelopeV1 = webhook.WebhookEventEnvelopeV1;
const WEBHOOK_QUEUE_BY_SOURCE: Record<string, string> = {
  github: "WH_GITHUB",
  "google-drive": "WH_GOOGLE_DRIVE",
  gmail: "WH_GMAIL",
  stripe: "WH_STRIPE",
};
export async function publishWebhookEvent(
  env: Partial<Record<string, Queue<WebhookEventEnvelopeV1>>>,
  envelope: WebhookEventEnvelopeV1,
): Promise<void> {
  const binding = WEBHOOK_QUEUE_BY_SOURCE[envelope.source];
  if (!binding) throw new DubError("EVENTS_UNKNOWN_EVENT", `Unknown webhook source: ${envelope.source}`, { status: 500 });
  const queue = env[binding];
  if (!queue) throw new DubError("EVENTS_MISSING_BINDING", `Missing webhook queue binding ${binding}`, { status: 500 });
  await queue.send(envelope);
}

export type EventsErrorCode =
  | "EVENTS_UNKNOWN_EVENT"
  | "EVENTS_MISSING_BINDING"
  | "EVENTS_PAYLOAD_TOO_LARGE"
  | "EVENTS_PUBLISH_FAILED"
  | "EVENTS_ENVELOPE_INVALID";
