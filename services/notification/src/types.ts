// Service-internal types — the delivery-layer machinery that the frozen
// @dub/types notification namespace deliberately leaves to the implementation.
// Public HTTP I/O ALWAYS uses @dub/types (see app.ts); nothing here is a wire type.
import type { notification } from "@dub/types";

export type NotificationChannel = notification.NotificationChannel;
export type NotificationType = notification.NotificationType;

// urgent is an internal signal (frozen NotifyRequest has no priority field): it is
// derived from the EventMappingRule for lane-A events and defaults to "normal" for
// the ad-hoc /notify + notification.requested lanes. It drives the email default.
export type NotificationPriority = "normal" | "urgent";

// Ingest origin.
export type IngestSource = "queue" | "api";

// Recipient specification. The public POST /notify only carries direct userIds
// (frozen contract), but lane-A mappings and public.inquiry produce roles/eventId
// specs that the RecipientResolver expands.
export interface NotifyRecipients {
  userIds?: string[];
  roles?: string[]; // identity GET /users?roleKey=
  eventId?: string; // event GET /events/:id/participants
  all?: boolean; // broadcast — every active user (identity GET /users, paged). Release notes.
}

// Normalized ingest input shared by all three lanes.
export interface IngestInput {
  type: NotificationType;
  recipients: NotifyRecipients;
  title: string;
  body: string | null;
  priority: NotificationPriority;
  channels?: NotificationChannel[]; // desired; preferences decide the final set
  dedupKey?: string;
  resourceType?: string | null;
  resourceId?: string | null;
  meta?: Record<string, string>;
  source: IngestSource;
  sourceEvent?: string; // populated when source === "queue"
  actorId: string | null;
  requestId: string; // correlation id (envelope.requestId / x-dub-request-id)
}

export interface IngestResult {
  notificationId: string;
  deduplicated: boolean;
}

// ---- channel abstraction (design §2) ----
export interface DeliveryJob {
  notificationId: string;
  userId: string;
  channel: NotificationChannel;
  type: NotificationType;
  title: string;
  body: string | null;
  priority: NotificationPriority;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string;
}

export type DeliveryOutcome = "sent" | "failed" | "skipped";

export interface DeliveryResult {
  status: DeliveryOutcome;
  detail?: string;
}

export interface ChannelAdapter {
  readonly channel: NotificationChannel;
  deliver(job: DeliveryJob): Promise<DeliveryResult>;
}

// ---- lane-A declarative mapping (design §4) ----
export interface EventMappingRule {
  type: NotificationType;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  buildRecipients(payload: unknown): NotifyRecipients;
  buildContent(payload: unknown): { title: string; body?: string; resourceType?: string; resourceId?: string };
  buildDedupKey?(payload: unknown): string;
}
