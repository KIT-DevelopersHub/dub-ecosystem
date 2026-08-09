// Domain-event publishing (canonical envelope via @dub/events). deploy-service emits
// two frozen events, both fanned out to notification (SUBSCRIPTIONS -> EVT_NOTIFICATION).
import { createEvent, publishEvent } from "@dub/events";
import type { DubEventEnvelope, DubEventContext, DubEventPublisherEnv } from "@dub/events";
import type { deploy } from "@dub/types";
import type { Queue } from "@cloudflare/workers-types";

export interface EventBus {
  deploymentStatusChanged(
    ctx: DubEventContext,
    payload: { deploymentId: string; status: deploy.DeploymentStatus },
  ): Promise<void>;
  dnsRecordChanged(ctx: DubEventContext, payload: { zone: string; name: string }): Promise<void>;
}

export function createEventBus(deps: { notificationQueue: Queue<DubEventEnvelope> }): EventBus {
  const publisherEnv: DubEventPublisherEnv = { EVT_NOTIFICATION: deps.notificationQueue };
  return {
    async deploymentStatusChanged(ctx, payload) {
      await publishEvent(publisherEnv, createEvent("deploy.deployment.status_changed", payload, ctx));
    },
    async dnsRecordChanged(ctx, payload) {
      await publishEvent(publisherEnv, createEvent("deploy.dns.record_changed", payload, ctx));
    },
  };
}
