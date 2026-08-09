// NotificationApi — the thin typed facade FE5 uses over FE2's @dub/api-client.
// Every call goes through the injected ApiClient (auth header, correlation id,
// ApiError normalisation live in FE2 — never fetch directly here). Paths are the
// gateway paths under API_PREFIX (FE5 §2-3).

import { common } from "@dub/types";
import type { ApiClient } from "../contracts/fe2";
import type {
  GetPreferencesResponse,
  ListInboxResponse,
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
  markAllRead(req: ReadAllRequest): Promise<void>;
  getPreferences(): Promise<GetPreferencesResponse>;
  updatePreferences(req: UpdatePreferencesRequest): Promise<void>;
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
    async markAllRead(req) {
      await client.post<void>(`${BASE}/inbox/read-all`, req);
    },
    getPreferences() {
      return client.get<GetPreferencesResponse>(`${BASE}/preferences`);
    },
    async updatePreferences(req) {
      await client.patch<void>(`${BASE}/preferences`, req);
    },
  };
}

export { BASE as NOTIFICATION_API_BASE };
