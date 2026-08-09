// Ingest core (design §1): the single path shared by all three lanes
//   A) domain-event subscription → EventMappingRule → IngestInput
//   B) notification.requested queue event
//   C) POST /notify
// Steps: business dedup → persist canonical notification → resolve recipients →
// apply per-user preferences per channel → fan out to channel adapters (record
// every attempt). An empty recipient set is a no-op (design test #3).
import type { DbClient } from "@dub/db";
import type { AdapterRegistry } from "./adapters";
import { runDelivery, recordSkipped } from "./adapters";
import { findByDedupKey, insertNotification, listPreferenceOverrides } from "./repo";
import { resolveEnabled } from "./preferences";
import type { RecipientResolver } from "./recipients";
import type { RequestContext } from "@dub/http";
import type { Queue } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import { CHANNELS } from "./config";
import type { DeliveryJob, IngestInput, IngestResult, NotificationChannel } from "./types";

// Forced-in_app types bypass preferences for the in_app channel (design §3: the sole
// exception — system.announcement admin broadcast).
const FORCE_IN_APP_TYPES: ReadonlySet<string> = new Set(["system.announcement"]);

export interface IngestDeps {
  db: DbClient;
  resolver: RecipientResolver;
  adapters: AdapterRegistry;
  auditEnv: { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> };
  orgId: string;
  ctx: RequestContext;
  maxAttempts?: number;
}

export async function ingest(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  // 1. business dedup — 202 + deduplicated:true, never a 409 (design §6).
  if (input.dedupKey) {
    const existing = await findByDedupKey(deps.db, input.dedupKey);
    if (existing) return { notificationId: existing, deduplicated: true };
  }

  // 2. resolve recipients (may throw NOTIF_RECIPIENT_RESOLUTION_FAILED / 502).
  const userIds = await deps.resolver.resolve(input.recipients, deps.ctx);

  // 3. persist the canonical notification even when there are no recipients, so the
  //    dedup key is claimed and public.inquiry bodies are retained.
  const notificationId = await insertNotification(deps.db, input);

  if (userIds.length === 0) return { notificationId, deduplicated: false };

  const candidateChannels: NotificationChannel[] =
    input.channels && input.channels.length > 0 ? input.channels : [...CHANNELS];
  const forceInApp = FORCE_IN_APP_TYPES.has(input.type);

  // 4. per-user preference application + fan-out.
  for (const userId of userIds) {
    const overrides = await listPreferenceOverrides(deps.db, userId);
    for (const channel of candidateChannels) {
      const forced = forceInApp && channel === "in_app";
      const enabled = forced || resolveEnabled(overrides, input.type, channel, input.priority);
      const job: DeliveryJob = {
        notificationId,
        userId,
        channel,
        type: input.type,
        title: input.title,
        body: input.body,
        priority: input.priority,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        requestId: input.requestId,
      };
      if (!enabled) {
        await recordSkipped(deps.db, job, "preference_off");
        continue;
      }
      await runDelivery(
        {
          db: deps.db,
          adapters: deps.adapters,
          auditQueue: deps.auditEnv,
          orgId: deps.orgId,
          ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
        },
        job,
      );
    }
  }

  return { notificationId, deduplicated: false };
}
