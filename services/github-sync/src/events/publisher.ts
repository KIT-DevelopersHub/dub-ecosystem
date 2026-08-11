// Domain-event + audit publishing port. Wraps @dub/events; uses the FROZEN
// payload shapes from DubEventPayloadMap (github.* = {taskId, repo} / {scope} …),
// which are intentionally leaner than the P0a proposal.
import {
  createEvent,
  publishEvent,
  publishAudit,
  type DubEventContext,
  type DubEventEnvelope,
  type DubEventPublisherEnv,
  type AuditRecordEnvelopeV1,
} from "@dub/events";
import type { Queue } from "@cloudflare/workers-types";
import type { auditLog } from "@dub/types";
import type { Env } from "../env";
import { AUDIT_TOPIC, EVENT_BINDING_TOPIC, outboxQueue } from "../outbox";

// Prefer a real (paid) Queue binding when present; otherwise fall back to the free-tier
// @dub/freeq D1 outbox shim so github/audit records are durably persisted, never dropped.
// The resulting env is exactly the DubEventPublisherEnv publishEvent reads by binding name.
export function buildPublisherEnv(env: Env): DubEventPublisherEnv {
  const out: DubEventPublisherEnv = {};
  for (const [binding, topic] of Object.entries(EVENT_BINDING_TOPIC)) {
    const real = (env as unknown as Record<string, Queue<DubEventEnvelope> | undefined>)[binding];
    out[binding] = real ?? outboxQueue<DubEventEnvelope>(env.DB, topic);
  }
  return out;
}

export function buildAuditQueue(env: Env): Queue<AuditRecordEnvelopeV1> {
  return env.AUDIT_QUEUE ?? outboxQueue<AuditRecordEnvelopeV1>(env.DB, AUDIT_TOPIC);
}

export interface Publisher {
  linkCreated(ctx: DubEventContext, taskId: string, repo: string): Promise<void>;
  linkRemoved(ctx: DubEventContext, taskId: string, repo: string): Promise<void>;
  syncCompleted(ctx: DubEventContext, scope: string): Promise<void>;
  syncFailed(ctx: DubEventContext, scope: string, error: string): Promise<void>;
  conflictDetected(ctx: DubEventContext, taskId: string): Promise<void>;
  audit(input: auditLog.AuditRecordInput): Promise<void>;
}

export class QueuePublisher implements Publisher {
  constructor(
    private readonly queues: DubEventPublisherEnv,
    private readonly auditQueue: Queue<import("@dub/events").AuditRecordEnvelopeV1>,
  ) {}
  async linkCreated(ctx: DubEventContext, taskId: string, repo: string): Promise<void> {
    await publishEvent(this.queues, createEvent("github.link_created", { taskId, repo }, ctx));
  }
  async linkRemoved(ctx: DubEventContext, taskId: string, repo: string): Promise<void> {
    await publishEvent(this.queues, createEvent("github.link_removed", { taskId, repo }, ctx));
  }
  async syncCompleted(ctx: DubEventContext, scope: string): Promise<void> {
    await publishEvent(this.queues, createEvent("github.sync_completed", { scope }, ctx));
  }
  async syncFailed(ctx: DubEventContext, scope: string, error: string): Promise<void> {
    await publishEvent(this.queues, createEvent("github.sync_failed", { scope, error }, ctx));
  }
  async conflictDetected(ctx: DubEventContext, taskId: string): Promise<void> {
    await publishEvent(this.queues, createEvent("github.conflict_detected", { taskId }, ctx));
  }
  async audit(input: auditLog.AuditRecordInput): Promise<void> {
    await publishAudit({ AUDIT_QUEUE: this.auditQueue }, input);
  }
}
