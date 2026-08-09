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
export { usePreferences } from "./hooks/usePreferences";
export type { UsePreferencesResult } from "./hooks/usePreferences";
export { useUnreadStore, getUnreadCount } from "./store/unread-store";

// ---- Components ----
export { NotificationInboxPage } from "./components/NotificationInboxPage";
export { NotificationPreferencesPage } from "./components/NotificationPreferencesPage";
export { NotificationBell } from "./components/NotificationBell";
export { NotificationList } from "./components/NotificationList";
export { NotificationListItem, itemLinkUrl } from "./components/NotificationListItem";
export { NotificationFilterBar } from "./components/NotificationFilterBar";
export { NotificationTypeLabel } from "./components/NotificationTypeLabel";
export { PreferenceMatrix } from "./components/PreferenceMatrix";
export { MarkAllReadButton } from "./components/MarkAllReadButton";

// ---- API facade ----
export { createNotificationApi, NOTIFICATION_API_BASE } from "./api/client";
export type { NotificationApi } from "./api/client";
export { createMockApiClient, MockApiError, DEFAULT_PREFERENCES } from "./api/mock-client";

// ---- Contracts + pure lib (for the shell / tests) ----
export type {
  ApiClient,
  ApiError,
  FeatureModule,
  FeatureRoute,
  FeatureNav,
  OptimisticMutationSpec,
} from "./contracts/fe2";
export { isApiError } from "./contracts/fe2";
export type { IconName } from "./contracts/fe1";
export * as inboxFilter from "./lib/inbox-filter";
export * as preferenceMerge from "./lib/preference-merge";
export * as typeDictionary from "./lib/type-dictionary";
export * as routes from "./lib/routes";
export {
  ROUTE_INBOX,
  ROUTE_PREFERENCES,
  PERM_INBOX,
  PERM_PREFS,
  resolveLinkUrl,
} from "./lib/routes";
