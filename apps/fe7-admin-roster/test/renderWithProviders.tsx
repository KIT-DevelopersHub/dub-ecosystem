// @vitest-environment jsdom
import { vi } from "vitest";
import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { gateway, identity } from "@dub/types";
import { RosterProvider } from "../src/providers/RosterProvider";
import { NavigationProvider, type Navigation } from "../src/providers/NavigationContext";
import { createMockClient, type MockSeed } from "../src/api/mockClient";
import type { ResourceClient } from "../src/shell/contract";

export function makeMe(permissions: identity.PermissionKey[]): gateway.MeResponse {
  return {
    user: { id: "user_alice", displayName: "Alice Admin", avatarUrl: null },
    orgId: "org_devhub",
    permissions,
    sessionExpiresAt: Date.now() + 3600_000,
  };
}

export interface RenderOptions {
  me?: gateway.MeResponse | null;
  client?: ResourceClient;
  seed?: MockSeed;
  navigation?: Partial<Navigation>;
}

export function renderWithProviders(ui: ReactElement, opts: RenderOptions = {}): RenderResult & { navigate: ReturnType<typeof vi.fn> } {
  const me = opts.me === undefined ? makeMe(["identity:read", "identity:admin", "audit:read", "event:read"]) : opts.me;
  const client = opts.client ?? createMockClient(opts.seed ?? (me ? { me } : undefined));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const navigate = vi.fn(opts.navigation?.navigate);
  const navigation: Navigation = { params: opts.navigation?.params ?? {}, navigate };

  const result = render(
    <QueryClientProvider client={qc}>
      <RosterProvider client={client} me={me}>
        <NavigationProvider value={navigation}>{ui}</NavigationProvider>
      </RosterProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { navigate });
}
