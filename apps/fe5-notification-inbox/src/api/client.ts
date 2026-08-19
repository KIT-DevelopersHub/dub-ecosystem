// NotificationApi — the thin typed facade FE5 uses over FE2's @dub/api-client.
// Every call goes through the injected ApiClient (auth header, correlation id,
// ApiError normalisation live in FE2 — never fetch directly here). Paths are the
// gateway paths under API_PREFIX (FE5 §2-3).

import { common } from "@dub/types";
import type { ApiClient } from "../contracts/fe2";
import type {
  GetPreferencesResponse,
  ListInboxResponse,
  ListAdminNotificationsParams,
  ListAdminNotificationsResponse,
  PublishBroadcastResponse,
  PublishBroadcastBatchResponse,
  UnpublishBroadcastResponse,
  UnpublishBroadcastBatchResponse,
  PublishReleaseRequest,
  PublishReleaseResponse,
  ReadAllRequest,
  UnreadCountResponse,
  UpdatePreferencesRequest,
} from "../contracts/notification-api";
import type { InboxQueryParams } from "../lib/inbox-filter";

const BASE = `${common.API_PREFIX}/notifications`; // "/api/v1/notifications"

export interface NotificationApi {
  listInbox(query: InboxQueryParams): Promise<ListInboxResponse>;
  getUnreadCount(): Promise<UnreadCountResponse>;
  markRead(id: string): Promise<void>;
  /** Restore a previously-read item to unread (additive inverse of markRead). */
  markUnread(id: string): Promise<void>;
  markAllRead(req: ReadAllRequest): Promise<void>;
  getPreferences(): Promise<GetPreferencesResponse>;
  updatePreferences(req: UpdatePreferencesRequest): Promise<void>;
  /** Admin: publish a release note broadcast to every user's inbox. */
  publishRelease(req: PublishReleaseRequest): Promise<PublishReleaseResponse>;
  /** Admin (notif:broadcast_publish): list audience='admin' notifications to manage. */
  listAdminNotifications(params?: ListAdminNotificationsParams): Promise<ListAdminNotificationsResponse>;
  /** Admin: publish one admin notification to all members as a broadcast. */
  publishBroadcast(id: string): Promise<PublishBroadcastResponse>;
  /** Admin: publish MANY admin notifications to members in one round trip (bulk). */
  publishBroadcastBatch(ids: string[]): Promise<PublishBroadcastBatchResponse>;
  /** Admin: unpublish (retract) one broadcast so members no longer see it. Idempotent. */
  unpublishBroadcast(id: string): Promise<UnpublishBroadcastResponse>;
  /** Admin: unpublish MANY broadcasts in one round trip (bulk retract). */
  unpublishBroadcastBatch(ids: string[]): Promise<UnpublishBroadcastBatchResponse>;
}

export function createNotificationApi(client: ApiClient): NotificationApi {
  return {
    listInbox(query) {
      return client.get<ListInboxResponse>(`${BASE}/inbox`, query as Record<string, unknown>);
    },
    getUnreadCount() {
      return client.get<UnreadCountResponse>(`${BASE}/inbox/unread-count`);
    },
    async markRead(id) {
      await client.patch<void>(`${BASE}/inbox/${encodeURIComponent(id)}/read`);
    },
    async markUnread(id) {
      await client.patch<void>(`${BASE}/inbox/${encodeURIComponent(id)}/unread`);
    },
    async markAllRead(req) {
      await client.post<void>(`${BASE}/inbox/read-all`, req);
    },
    getPreferences() {
      return client.get<GetPreferencesResponse>(`${BASE}/preferences`);
    },
    async updatePreferences(req) {
      await client.patch<void>(`${BASE}/preferences`, req);
    },
    publishRelease(req) {
      return client.post<PublishReleaseResponse>(`${BASE}/release`, req);
    },
    listAdminNotifications(params) {
      return client.get<ListAdminNotificationsResponse>(`${BASE}/manage`, params as Record<string, unknown> | undefined);
    },
    publishBroadcast(id) {
      return client.post<PublishBroadcastResponse>(`${BASE}/manage/${encodeURIComponent(id)}/publish`);
    },
    publishBroadcastBatch(ids) {
      return client.post<PublishBroadcastBatchResponse>(`${BASE}/manage/publish-batch`, { ids });
    },
    unpublishBroadcast(id) {
      return client.post<UnpublishBroadcastResponse>(`${BASE}/manage/${encodeURIComponent(id)}/unpublish`);
    },
    unpublishBroadcastBatch(ids) {
      return client.post<UnpublishBroadcastBatchResponse>(`${BASE}/manage/unpublish-batch`, { ids });
    },
  };
}

export { BASE as NOTIFICATION_API_BASE };
