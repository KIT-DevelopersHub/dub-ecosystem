// @vitest-environment jsdom
import { vi } from "vitest";
import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { gateway, identity } from "@dub/types";
import { policy } from "@dub/types";
import { RosterProvider } from "../src/providers/RosterProvider";
import { NavigationProvider, type Navigation } from "../src/providers/NavigationContext";
import { createMockClient, type MockSeed } from "../src/api/mockClient";
import type { ResourceClient } from "../src/shell/contract";

export function makeMe(
  permissions: identity.PermissionKey[],
  opts: { exact?: boolean } = {},
): gateway.MeResponse {
  // Write affordances are gated on the POLICY (identity:admin AND 編集 on the 管理 app), so a
  // fixture that grants identity:admin must also carry the 管理 app's graded keys — exactly
  // what migration 0010 guarantees in production. Mirrored here (instead of in every test)
  // so `makeMe(["identity:read"])` still means "read-only viewer" and nothing else changes.
  // `exact: true` opts out, for the case that matters most: an admin whose 管理 app was set
  // to 閲覧 (identity:admin WITHOUT app:admin:edit) must see no write control at all.
  const all = new Set<identity.PermissionKey>(permissions);
  if (!opts.exact && all.has("identity:admin")) {
    for (const key of policy.keysForAppLevel("admin", policy.AppAccessLevel.Edit)) all.add(key);
  }
  return {
    user: { id: "user_alice", displayName: "Alice Admin", avatarUrl: null },
    orgId: "org_devhub",
    permissions: [...all],
    appAccess: policy.appAccessMap(all),
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
  // Default subject = a real admin: identity:admin AND 編集 on the 管理 app (what migration
  // 0010 grants in production). Write controls are gated on BOTH now, like the server.
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
