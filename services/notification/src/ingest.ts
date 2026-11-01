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
import type { InboxRealtimePublisher } from "./realtime";
import { resolveEnabled } from "./preferences";
import type { RecipientResolver } from "./recipients";
import type { RequestContext } from "@dub/http";
import type { Queue } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import { CHANNELS, BROADCAST_IN_APP_TYPES } from "./config";
import type { DeliveryJob, IngestInput, IngestResult, NotificationChannel } from "./types";

// Forced-in_app types bypass preferences for the in_app channel (design §3: the sole
// exception — admin broadcast). `release` (new-feature announcements) always lands in
// every recipient's inbox so nobody misses a release note, same as system.announcement.
// The force is in_app-only: the push that rides along (withInboxPush) still obeys prefs.
const FORCE_IN_APP_TYPES: ReadonlySet<string> = new Set(BROADCAST_IN_APP_TYPES);

// Policy: everything that targets the inbox (in_app) is also pushed to the user's
// devices; users opt out per type via their push preference. Done here — once — so
// producers keep declaring just "in_app" and new notification types can't miss push.
export function withInboxPush(channels: readonly NotificationChannel[]): NotificationChannel[] {
  return channels.includes("in_app") && !channels.includes("push") ? [...channels, "push"] : [...channels];
}

export interface IngestDeps {
  db: DbClient;
  resolver: RecipientResolver;
  adapters: AdapterRegistry;
  // null when neither a paid Queue nor the free-tier outbox is bound (publish skipped).
  auditEnv: { AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1> } | null;
  orgId: string;
  ctx: RequestContext;
  maxAttempts?: number;
  // Optional realtime push: after an in_app row is committed, signal the recipient's live
  // WS sockets so the fe5 badge refetches instantly. Absent -> no push (poller reconciles).
  realtime?: InboxRealtimePublisher;
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

  const candidateChannels = withInboxPush(
    input.channels && input.channels.length > 0 ? input.channels : [...CHANNELS],
  );
  const forceInApp = FORCE_IN_APP_TYPES.has(input.type);
  // Users who received an in_app row this ingest — signalled over realtime after the loop.
  const inAppDelivered = new Set<string>();

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
      if (channel === "in_app") inAppDelivered.add(userId);
    }
  }

  // 5. realtime: signal each recipient whose inbox gained an in_app row so the fe5 badge
  // updates instantly (the client refetches the authoritative count). Best-effort and
  // AFTER the D1 commits — the poller reconciles if a push is lost.
  if (deps.realtime && inAppDelivered.size > 0) {
    await Promise.all([...inAppDelivered].map((uid) => deps.realtime!.pushInboxChanged(uid)));
  }

  return { notificationId, deduplicated: false };
}
