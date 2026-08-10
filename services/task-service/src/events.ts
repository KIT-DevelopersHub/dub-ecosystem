// Event publishing + audit seams. The app builds canonical envelopes via
// @dub/events createEvent (ULID id / requestId / actorId) and hands them to the
// publisher; a paid deploy fans out through the Queue producer bindings, while a
// free-tier deploy (no Queues) falls back to the @dub/freeq D1 outbox shim.
import type { Queue } from "@cloudflare/workers-types";
import {
  createEvent,
  publishEvents,
  publishAudit,
  type DubEventEnvelope,
  type DubEventName,
  type DubEventPayloadMap,
  type DubEventPublisherEnv,
  type AuditRecordEnvelopeV1,
} from "@dub/events";
import type { auditLog } from "@dub/types";
import type { Env } from "./env";
import { AUDIT_TOPIC, EVENT_BINDING_TOPIC, outboxQueue } from "./outbox";

export interface EventSpec<N extends DubEventName = DubEventName> {
  name: N;
  payload: DubEventPayloadMap[N];
}

export interface PublishContext {
  requestId: string;
  actorId: string | null;
  occurredAt?: string;
}

export interface EventPublisher {
  publish(envelopes: DubEventEnvelope[]): Promise<void>;
}
export interface Auditor {
  record(input: auditLog.AuditRecordInput): Promise<void>;
}

/** Build canonical envelopes then publish (no-op when there is nothing to send). */
export async function emit(
  publisher: EventPublisher,
  ctx: PublishContext,
  specs: EventSpec[],
): Promise<DubEventEnvelope[]> {
  if (specs.length === 0) return [];
  const envelopes = specs.map((s) =>
    createEvent(s.name, s.payload, {
      requestId: ctx.requestId,
      actorId: ctx.actorId,
      ...(ctx.occurredAt ? { occurredAt: ctx.occurredAt } : {}),
    }),
  );
  await publisher.publish(envelopes);
  return envelopes;
}

// ---- production wiring ----
// Prefer a real (paid) Queue binding when present; otherwise fall back to the free-tier
// @dub/freeq D1 outbox shim so task/audit records are durably persisted, never dropped.
// The resulting env is exactly the DubEventPublisherEnv publishEvents reads by binding name.
export function buildPublisherEnv(env: Env): DubEventPublisherEnv {
  const out: DubEventPublisherEnv = {};
  for (const [binding, topic] of Object.entries(EVENT_BINDING_TOPIC)) {
    const real = (env as unknown as Record<string, Queue<DubEventEnvelope> | undefined>)[binding];
    out[binding] = real ?? outboxQueue<DubEventEnvelope>(env.DB, topic);
  }
  return out;
}

export function buildAuditEnv(env: Env): { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> } {
  return { AUDIT_QUEUE: env.AUDIT_QUEUE ?? outboxQueue<AuditRecordEnvelopeV1>(env.DB, AUDIT_TOPIC) };
}

export function createQueueEventPublisher(env: DubEventPublisherEnv): EventPublisher {
  return {
    publish: (envelopes) => publishEvents(env, envelopes),
  };
}

export function createQueueAuditor(env: { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> }): Auditor {
  return {
    record: (input) => publishAudit(env, input),
  };
}
