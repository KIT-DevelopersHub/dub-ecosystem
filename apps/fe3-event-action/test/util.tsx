import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { identity } from "@dub/types";
import { ToastProvider } from "../src/contracts/fe1";
import { useAuthStore } from "../src/contracts/fe2";
import { NavigationProvider, type NavigationApi } from "../src/contracts/navigation";
import { EventApiProvider, RegistryProvider } from "../src/context/ApiContext";
import { createActionTypeRegistry, type ActionTypeRegistry } from "../src/registry/ActionTypeRegistry";
import { genericActionPlugin } from "../src/components/GenericActionPanel";
import { createMockEventApi } from "../src/api/mockData";
import type { EventApi } from "../src/api/eventApi";

export function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function setAuth(permissions: identity.PermissionKey[]): void {
  useAuthStore.getState().setMe({
    user: { id: "usr_test", displayName: "テスト", avatarUrl: null },
    orgId: "org_devhub",
    permissions,
    sessionExpiresAt: Date.now() + 3600_000,
  });
}

export function resetAuth(): void {
  useAuthStore.setState({ me: null, loading: true });
}

export interface RenderOpts {
  api?: EventApi;
  registry?: ActionTypeRegistry;
  nav?: Partial<NavigationApi>;
  queryClient?: QueryClient;
}

export function renderWithProviders(ui: ReactNode, opts: RenderOpts = {}): RenderResult & {
  api: EventApi;
  registry: ActionTypeRegistry;
  navigate: ReturnType<typeof makeNav>["navigate"];
} {
  const api = opts.api ?? createMockEventApi({ events: 2, actionsPerEvent: 3 });
  const registry = opts.registry ?? createActionTypeRegistry(genericActionPlugin);
  const qc = opts.queryClient ?? newQueryClient();
  const nav = makeNav(opts.nav);

  const result = render(
    <QueryClientProvider client={qc}>
      <EventApiProvider api={api}>
        <RegistryProvider registry={registry}>
          <NavigationProvider value={nav}>
            <ToastProvider>{ui}</ToastProvider>
          </NavigationProvider>
        </RegistryProvider>
      </EventApiProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { api, registry, navigate: nav.navigate });
}

export function makeNav(partial?: Partial<NavigationApi>): NavigationApi & { navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn();
  return {
    navigate,
    params: {},
    search: "",
    setSearch: vi.fn(),
    ...partial,
    // keep our spy even if partial provides navigate
    ...(partial?.navigate ? {} : { navigate }),
  } as NavigationApi & { navigate: ReturnType<typeof vi.fn> };
}
