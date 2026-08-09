// mobile — MO3 mobile-bff namespace (owner=MO3). OpenAPI generation source
// (swift5/kotlin). Sync/mutations are STUB (implemented in a later wave).
import type { UserId, ISODateTime, Paginated, CursorQuery } from "./common";
import type { EventSummary } from "./event";
import type { TaskSummary } from "./task";
import type { PermissionKey } from "./identity";
import type { NotificationType } from "./notification";

export type MobilePlatform = "ios" | "android";

export interface MobileHomeResponse {
  upcomingEvents: EventSummary[];
  myTasks: TaskSummary[];
  unreadCount: number;
}
export interface MobileEventOverviewResponse {
  event: EventSummary;
  capabilities: PermissionKey[];
}
export interface RegisterDeviceRequest {
  platform: MobilePlatform;
  pushToken: string;
}
export interface RegisterDeviceResponse {
  deviceId: string;
}
export interface DeviceDto {
  id: string;
  platform: MobilePlatform;
  registeredAt: ISODateTime;
}
export interface PushDispatchRequest {
  userId: UserId;
  type: NotificationType;
  payload: MobilePushPayload;
}
export interface MobilePushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

// ---- STUB: sync/mutations は実装後段で確定 ----
export interface SyncQuery extends CursorQuery {
  since?: ISODateTime; // STUB
}
export interface SyncResponse extends Paginated<unknown> {
  serverTime: ISODateTime; // STUB
}
