// notification — notification namespace.
import type { NotificationId, UserId, ISODateTime, Paginated, CursorQuery } from "./common";

export type NotificationChannel = "in_app" | "email" | "chat" | "push"; // 4 closed (theme4)
export type NotificationType = string; // open vocabulary

export interface NotifyRequest {
  type: NotificationType;
  recipientIds: UserId[];
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
