// Outbound event + audit sinks. Interfaces keep the pipeline testable; Worker impls
// bind to @dub/events (canonical envelope) and publishAudit (Queue audit channel).
import type { Queue } from "@cloudflare/workers-types";
import type { auditLog } from "@dub/types";
import {
  createEvent,
  publishEvent,
  publishAudit,
  type DubEventEnvelope,
  type MailAutomationDecidedPayload,
  type MailAutomationRoutedPayload,
} from "@dub/events";

export interface RunContext {
  requestId: string;
  actorId: string | null;
}

export interface EventPublisher {
  decided(payload: MailAutomationDecidedPayload, run: RunContext): Promise<void>;
  routed(payload: MailAutomationRoutedPayload, run: RunContext): Promise<void>;
}

export interface AuditSink {
  record(input: auditLog.AuditRecordInput): Promise<void>;
}

type PublisherEnv = Partial<Record<string, Queue<DubEventEnvelope>>>;

/**
 * Worker EventPublisher. publishEvent routes each event to its subscribers'
 * queue bindings per the frozen SUBSCRIPTIONS table (decided/routed -> notification
 * via EVT_NOTIFICATION).
 */
export function createEventPublisher(env: PublisherEnv): EventPublisher {
  return {
    async decided(payload, run) {
      const event = createEvent("mail.automation.decided", payload, { requestId: run.requestId, actorId: run.actorId });
      await publishEvent(env, event);
    },
    async routed(payload, run) {
      const event = createEvent("mail.automation.routed", payload, { requestId: run.requestId, actorId: run.actorId });
      await publishEvent(env, event);
    },
  };
}

/** Worker AuditSink (Queue publishAudit — the default audit path, theme#13). */
export function createAuditSink(env: { AUDIT_QUEUE: Queue<never> }): AuditSink {
  return {
    async record(input) {
      await publishAudit(env as never, input);
    },
  };
}
