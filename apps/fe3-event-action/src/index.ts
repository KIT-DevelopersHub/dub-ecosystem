// @dub/fe3-event-action — public surface consumed by FE2 (mounts the module) and
// FE4/FE5/FE6 (registry, EventPicker, useEventContext, route builders).

// FeatureModule + registry singleton
export { eventFeatureModule, actionTypeRegistry } from "./module";

// ActionTypeRegistry contract (FE4 exports taskActionPlugin: ActionTypePlugin)
export {
  createActionTypeRegistry,
  type ActionTypeRegistry,
  type ActionTypePlugin,
  type ActionPanelProps,
} from "./registry/ActionTypeRegistry";

// Shared components/hooks for other units
export { EventPicker, type EventPickerProps } from "./components/EventPicker";
export {
  EventContextProvider,
  useEventContext,
  type EventContextValue,
} from "./context/EventContext";
export { EventApiProvider, RegistryProvider } from "./context/ApiContext";

// Route builders (other units link into the hierarchy)
export { eventRoutes, chatHref, routePaths } from "./lib/routes";

// API contract (FE2 injects the real client; tests/dev use the mock)
export { createHttpEventApi, type EventApi } from "./api/eventApi";
export { createMockEventApi } from "./api/mockData";
export type {
  CreateActionRequest,
  UpdateActionRequest,
  ListActionsQuery,
  ListActionsResponse,
} from "./api/actionContracts";

// Pure helpers other units may reuse
export {
  phaseTransitionOptions,
  canTransition,
  isTransitionAllowed,
  requiredPermissionForTransition,
} from "./lib/phase";
export { derivePermissions, type EventPermissions } from "./lib/permissions";
export { eventKeys } from "./lib/queryKeys";
export { EventErrorCodes, classifyError } from "./lib/errorMap";

// Pages (FE2 registers these via eventFeatureModule; re-exported for direct mount)
export { EventListPage } from "./pages/EventListPage";
export { EventDetailPage } from "./pages/EventDetailPage";
export { ActionDetailPage } from "./pages/ActionDetailPage";
export { EventSettingsPage } from "./pages/EventSettingsPage";
