// FE2 public contract barrel (design 2-3). FE3-FE7 import the shell's cross-cutting
// surface from here (intended alias: @spa/shell — kept as a relative import for now
// so the inherited tsconfig `paths` for @dub/* stay intact; see notes).

// ---- API client ----
export {
  createApiClient,
  ApiError,
  toDisplayableError,
  type ApiClient,
  type ApiClientConfig,
  type ResourceClient,
  type RequestInput,
  type HttpMethod,
  type AuthLoginStartResponse,
} from "./lib/api-client.tsx";

// ---- query conventions & optimistic mutation ----
export { queryKeys } from "./lib/queryKeys.tsx";
export { createOptimisticMutation, type OptimisticMutationOpts } from "./lib/optimistic.tsx";

// ---- FeatureModule contract & registry ----
export {
  registerFeatureModules,
  buildRegistry,
  getRegistry,
} from "./modules/registry.tsx";
export type {
  FeatureModule,
  FeatureModuleId,
  FeatureRoute,
  NavEntry,
  Registry,
  ResolvedRoute,
} from "./modules/types.tsx";

// ---- auth / permission guards ----
export {
  AuthProvider,
  RequireAuth,
  RequirePermission,
  useAuth,
  useRequireAuth,
  usePermissions,
  type AuthState,
} from "./auth/AuthProvider.tsx";

// ---- UI store (theme source of truth) ----
export { useUiStore, type UiStore } from "./store/uiStore.tsx";

// ---- BFF home partial-failure hook ----
export { useBffHome, type UseBffHomeResult } from "./bff/useBffHome.tsx";

// ---- shell composition ----
export { AppRoot, createQueryClient } from "./shell/AppRoot.tsx";
export { AppShellLayout, type AppShellLayoutProps } from "./shell/AppShellLayout.tsx";
export { createShellRouter, toTanstackPath } from "./shell/router.tsx";
export { GlobalErrorFallback } from "./shell/GlobalErrorFallback.tsx";
export { RouteLoadingBar } from "./shell/RouteLoadingBar.tsx";

// ---- FE1 re-exports (design 2-3): Toast type & component are FE1-owned; FE2 only
// mounts the provider and re-exports. Sourced from the FE1 stub until @dub/ui ships.
export { useToast, type ToastOptions, type DisplayableError } from "./stubs/dub-ui.tsx";
export type { IconName } from "./stubs/icons.tsx";
