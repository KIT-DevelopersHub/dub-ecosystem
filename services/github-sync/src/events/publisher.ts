// Domain-event + audit publishing port. Wraps @dub/events; uses the FROZEN
// payload shapes from DubEventPayloadMap (github.* = {taskId, repo} / {scope} …),
// which are intentionally leaner than the P0a proposal.
import {
  createEvent,
  publishEvent,
  publishAudit,
  type DubEventContext,
  type DubEventPublisherEnv,
} from "@dub/events";
import type { Queue } from "@cloudflare/workers-types";
import type { auditLog } from "@dub/types";

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
