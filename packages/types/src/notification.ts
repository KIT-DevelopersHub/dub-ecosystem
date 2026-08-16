// notification — notification namespace.
import type { NotificationId, UserId, ISODateTime, Paginated, CursorQuery } from "./common";

export type NotificationChannel = "in_app" | "email" | "chat" | "push"; // 4 closed (theme4)
export type NotificationType = string; // open vocabulary

// Audience gating for org-wide update notifications (Notification management, 2026-08).
//   - "admin":   the notification is admin-facing first (deploy done / feedback / ops
//                alerts). Only admins/maintainers see it; members never do.
//   - "members": member-visible (direct-to-user notifications AND admin-published
//                broadcasts). This is the default for every pre-existing notification so
//                a user always sees notifications addressed to them.
// Admins see BOTH audiences; members see only "members". An admin turns an "admin"
// notification into a "members" broadcast via the management screen.
export type NotificationAudience = "admin" | "members";

export interface NotifyRequest {
  type: NotificationType;
  recipientIds: UserId[];
  /** Role keys expanded to user ids by the notification service (identity roster). Lets a
   *  caller fan out to admins/maintainers without knowing user ids. At least one of
   *  recipientIds / recipientRoles must be non-empty; the two union. */
  recipientRoles?: string[];
  title: string;
  body: string;
  channels?: NotificationChannel[]; // P0 delivers in_app only; others are adapter stubs
  dedupKey?: string; // "{eventName}:{resourceId}" convention
  resourceType?: string;
  resourceId?: string;
}

export interface InboxItem {
  id: NotificationId;
  type: NotificationType;
  title: string;
  body: string;
  readAt: ISODateTime | null;
  createdAt: ISODateTime;
  resourceType: string | null;
  resourceId: string | null;
  /** Additive: audience of the underlying notification (defaults to "members" for rows
   *  produced before the field existed). Members only ever receive "members" rows. */
  audience?: NotificationAudience;
}
export interface ListInboxQuery extends CursorQuery {
  unreadOnly?: boolean;
}
export type ListInboxResponse = Paginated<InboxItem>;
export interface UnreadCountResponse {
  count: number;
}
export interface PreferenceEntry {
  type: NotificationType;
  channels: NotificationChannel[];
}

// ---- in-app feedback / contact (widget -> admin). The authenticated analogue of the
// public inquiry flow: a signed-in user reports "fix this here"; the record is stored
// append-only and admins read it. category is a small closed vocabulary.
export type FeedbackCategory = "bug" | "idea" | "question" | "other";

export interface CreateFeedbackRequest {
  message: string; // 1..4000
  category?: FeedbackCategory; // default "other"
  /** Where the feedback was raised (helps triage). Both optional. */
  page?: {
    url?: string; // e.g. https://app.dub/…/events/evt_123
    name?: string; // human screen name, e.g. "イベント詳細"
  };
}
export interface CreateFeedbackResponse {
  id: string;
  accepted: true;
}

export interface FeedbackItem {
  id: string;
  userId: UserId; // submitter
  category: FeedbackCategory;
  message: string;
  pageUrl: string | null;
  pageName: string | null;
  readAt: ISODateTime | null; // admin triage flag (null = unread)
  createdAt: ISODateTime;
}
export interface ListFeedbackQuery extends CursorQuery {
  unreadOnly?: boolean;
}
export type ListFeedbackResponse = Paginated<FeedbackItem>;

// ---- Notification management (admin) ----
// The admin screen lists audience="admin" notifications and can publish any of them to
// members as a broadcast. `publishedBroadcastId` is the id of the members broadcast
// derived from this notification (null until an admin publishes it) — drives the
// "公開済み" badge and the disabled state of the publish button.
export interface AdminNotificationItem {
  id: NotificationId;
  type: NotificationType;
  title: string;
  body: string;
  audience: NotificationAudience; // always "admin" on this list
  createdAt: ISODateTime;
  publishedBroadcastId: NotificationId | null;
}
export interface ListAdminNotificationsQuery extends CursorQuery {}
export type ListAdminNotificationsResponse = Paginated<AdminNotificationItem>;

// POST /notifications/manage/:id/publish — publish an admin notification to all members.
// Idempotent: re-publishing the same source returns the existing broadcast id with
// deduplicated=true.
export interface PublishBroadcastResponse {
  notificationId: NotificationId; // the members broadcast id
  deduplicated: boolean;
  publishedBroadcastId: NotificationId; // == notificationId (stable badge target)
}

// POST /notifications/manage/publish-batch — publish MANY admin notifications to members
// in one round trip (bulk "メンバーへ一括公開"). Each id is published idempotently and
// INDEPENDENTLY: one bad/duplicate id never fails the others; the per-item outcome tells
// the UI which rows flipped to 公開済み, which were already published, and which failed.
export interface PublishBroadcastBatchRequest {
  ids: NotificationId[]; // 1..N source (audience='admin') notification ids
}
export interface PublishBroadcastBatchItem {
  id: NotificationId; // the source admin notification id
  ok: boolean; // true when published or already-published (deduplicated); false on error
  deduplicated?: boolean; // true when it was already published (skipped)
  publishedBroadcastId?: NotificationId; // present when ok
  code?: string; // error code when ok=false (e.g. NOTIF_NOTIFICATION_NOT_FOUND)
}
export interface PublishBroadcastBatchResponse {
  results: PublishBroadcastBatchItem[];
  publishedCount: number; // newly published
  deduplicatedCount: number; // already published (skipped)
  failedCount: number;
}

// POST /notifications/manage/:id/unpublish — the inverse of publish. Retracts the members
// broadcast derived from an admin notification so members no longer see it (the broadcast
// row + its per-user inbox rows are removed). Idempotent: unpublishing something that was
// never published (or already retracted) is a no-op with retracted=false. The source admin
// notification itself is untouched, so the row simply flips back to publishable.
export interface UnpublishBroadcastResponse {
  notificationId: NotificationId; // the source admin notification id
  retracted: boolean; // true when a broadcast was removed; false on a no-op (not published)
  removedBroadcastId: NotificationId | null; // the broadcast id removed (null on no-op)
}

// POST /notifications/manage/unpublish-batch — retract MANY broadcasts in one round trip
// (bulk「選択したものを公開解除」). Each id is unpublished idempotently and INDEPENDENTLY, so
// one bad/unpublished id never fails the others; the per-item outcome tells the UI which
// rows flipped back to unpublished, which were already unpublished (no-op), and which failed.
export interface UnpublishBroadcastBatchRequest {
  ids: NotificationId[]; // 1..N source (audience='admin') notification ids
}
export interface UnpublishBroadcastBatchItem {
  id: NotificationId; // the source admin notification id
  ok: boolean; // true when retracted OR already-unpublished (no-op); false on error
  retracted?: boolean; // true when a broadcast was removed; false when it was a no-op
  removedBroadcastId?: NotificationId; // present when a broadcast was removed
  code?: string; // error code when ok=false (e.g. NOTIF_NOTIFICATION_NOT_FOUND)
}
export interface UnpublishBroadcastBatchResponse {
  results: UnpublishBroadcastBatchItem[];
  retractedCount: number; // broadcasts actually removed
  noopCount: number; // ids that were not published (already unpublished)
  failedCount: number;
}
