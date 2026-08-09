// Consumed-contract surface. The wire contract truth is @dub/types `mobile` +
// referenced namespaces (owner=MO3). Kotlin data classes are generated from
// MO3's OpenAPI (openapi-generator kotlin; hand-writing forbidden — §5/§8 #3).
// This file re-exports the frozen types MO2 consumes, and declares the few
// *client-side view shapes* the frozen package does not (yet) carry, clearly
// marked as CONSUMED-SHAPE so they are never mistaken for the contract source.
import type { auth, mobile, task, event, notification, identity, common } from "@dub/types";

// ---- re-exported frozen contract types (consumed as-is) ----
export type MobileHomeResponse = mobile.MobileHomeResponse;
export type MobileEventOverviewResponse = mobile.MobileEventOverviewResponse;
export type RegisterDeviceRequest = mobile.RegisterDeviceRequest;
export type RegisterDeviceResponse = mobile.RegisterDeviceResponse;
export type DeviceDto = mobile.DeviceDto;
export type MobilePushPayload = mobile.MobilePushPayload;
export type TaskSummary = task.TaskSummary;
export type Task = task.Task;
export type TaskStatus = task.TaskStatus;
export type UpdateTaskRequest = task.UpdateTaskRequest;
export type EventSummary = event.EventSummary;
export type InboxItem = notification.InboxItem;
export type ListInboxResponse = notification.ListInboxResponse;
export type PreferenceEntry = notification.PreferenceEntry;
export type PermissionKey = identity.PermissionKey;
export type SessionInfo = auth.SessionInfo;
export type MobileExchangeRequest = auth.MobileExchangeRequest;
export type Paginated<T> = common.Paginated<T>;

// ---- CONSUMED-SHAPE (not in frozen @dub/types yet) ----
// The single opaque session token (theme8): exchange/refresh return it plus the
// SessionInfo. MO3 emits this via OpenAPI; when it lands in the mobile namespace
// this alias collapses to the frozen type. Kept app-local, never re-declared in
// @dub/types (that package is owned by foundation-contracts / MO3).
export interface MobileAuthTokenResponse {
  token: string; // single opaque Bearer session token (NOT a JWT, NOT 2-token)
  refreshToken?: string; // mobile refresh (rotated on use; theme8)
  session: SessionInfo;
}

export interface MobileAuthExchangeBody extends MobileExchangeRequest {
  platform: "android" | "ios"; // AppAuth/PKCE handled natively; code posted here
}
