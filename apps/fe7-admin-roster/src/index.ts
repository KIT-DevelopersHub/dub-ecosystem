// FE7 public surface. FE2 imports `adminModule` (the one FeatureModule, id="admin")
// and registers it under the authenticated shell layout. Everything else is
// internal to the feature.
export { adminModule, routes, nav } from "./routes";
export { RosterProvider } from "./providers/RosterProvider";
export { NavigationProvider, useNavigation } from "./providers/NavigationContext";
export type { FeatureModule, FeatureRoute, NavEntry, ResourceClient } from "./shell/contract";
export { usePermissions } from "./hooks/usePermissions";
export { createRosterApi } from "./api/rosterApi";
export { createMockClient } from "./api/mockClient";
export { MailRateLimitBanner } from "./components/MailRateLimitBanner";
export type { MailRateLimitStatus, MailStatusResponse } from "./lib/mailStatus";
