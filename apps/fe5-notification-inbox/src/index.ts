// @dub/fe5-notification-inbox — public surface FE5 exposes into the admin SPA.
// The FeatureModule is the primary registration point; hooks/components/types
// are exported for the shell + tests. (Design FE5 §2-2.)

// ---- FeatureModule (primary registration) ----
export { notificationsModule } from "./module";
export { default } from "./module";

// ---- Provider (FE2 injects api-client / navigate / toast) ----
export { NotificationProvider, useNotificationDeps } from "./context";
export type { NotificationDeps, Toast, ToastKind } from "./context";

// ---- Hooks ----
export { useUnreadCount } from "./hooks/useUnreadCount";
export type { UseUnreadCountResult } from "./hooks/useUnreadCount";
export { useInbox } from "./hooks/useInbox";
export type { UseInboxOptions, UseInboxResult } from "./hooks/useInbox";
export { useAdminNotifications, PENDING_BROADCAST_ID } from "./hooks/useAdminNotifications";
export type { UseAdminNotificationsResult } from "./hooks/useAdminNotifications";
export { usePreferences } from "./hooks/usePreferences";
export type { UsePreferencesResult } from "./hooks/usePreferences";
export { useUnreadStore, getUnreadCount, useUnreadBadge } from "./store/unread-store";

// ---- Components ----
export { NotificationInboxPage } from "./components/NotificationInboxPage";
export { NotificationPreferencesPage } from "./components/NotificationPreferencesPage";
export { NotificationManagePage } from "./components/NotificationManagePage";
export { NotificationBell } from "./components/NotificationBell";
export { NotificationDialog } from "./components/NotificationDialog";
export {
  useNotificationDialogStore,
  openNotificationDialog,
} from "./store/dialog-store";
export { ReleasePublishForm } from "./components/ReleasePublishForm";
export type { ReleasePublishFormProps } from "./components/ReleasePublishForm";
export { NotificationList } from "./components/NotificationList";
export { NotificationCard, itemLinkUrl } from "./components/NotificationCard";
export { NotificationFilterBar } from "./components/NotificationFilterBar";
export { NotificationTypeLabel } from "./components/NotificationTypeLabel";
export { PreferenceMatrix } from "./components/PreferenceMatrix";
export { MarkAllReadButton } from "./components/MarkAllReadButton";

// ---- API facade ----
export { createNotificationApi, NOTIFICATION_API_BASE } from "./api/client";
export type { NotificationApi } from "./api/client";
export { createMockApiClient, MockApiError, DEFAULT_PREFERENCES } from "./api/mock-client";
// Real fetch-backed ApiClient (auth header + correlation id + ApiError
// normalisation) for the shell to inject in place of the mock.
export { createHttpApiClient, HttpApiError } from "./api/http-client";
export type { HttpApiClientConfig } from "./api/http-client";

// ---- Live unread-count transport (optional push path for the bell badge) ----
export {
  createReconnectingUnreadLive,
  createSseUnreadConnector,
  parseUnreadCount,
} from "./lib/unread-live";
export type {
  LiveConnection,
  LiveConnector,
  LiveHandlers,
  LiveStatus,
  UnreadLiveSource,
  EventSourceLike,
  EventSourceCtor,
  SseUnreadConnectorConfig,
} from "./lib/unread-live";

// ---- Contracts + pure lib (for the shell / tests) ----
export type {
  ApiClient,
  ApiError,
  FeatureModule,
  FeatureModuleId,
  FeatureRoute,
  NavEntry,
  OptimisticMutationSpec,
} from "./contracts/fe2";
export { isApiError } from "./contracts/fe2";
export type { IconName } from "@dub/ui";
export * as inboxFilter from "./lib/inbox-filter";
export * as preferenceMerge from "./lib/preference-merge";
export * as typeDictionary from "./lib/type-dictionary";
export * as routes from "./lib/routes";
export {
  ROUTE_INBOX,
  ROUTE_PREFERENCES,
  ROUTE_MANAGE,
  PERM_INBOX,
  PERM_PREFS,
  PERM_BROADCAST_PUBLISH,
  resolveLinkUrl,
} from "./lib/routes";
