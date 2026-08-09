// Event publishing + audit seams. The app builds canonical envelopes via
// @dub/events createEvent (ULID id / requestId / actorId) and hands them to the
// publisher; production fans out through the Queue producer bindings.
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
