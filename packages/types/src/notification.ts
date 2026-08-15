// notification — notification namespace.
import type { NotificationId, UserId, ISODateTime, Paginated, CursorQuery } from "./common";

export type NotificationChannel = "in_app" | "email" | "chat" | "push"; // 4 closed (theme4)
export type NotificationType = string; // open vocabulary

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
