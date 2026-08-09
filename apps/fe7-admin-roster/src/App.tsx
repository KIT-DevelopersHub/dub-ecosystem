// Standalone dev harness. NOT part of the production surface (FE2 mounts adminModule
// into its own shell/router). Provides an in-memory navigation + a mock ResourceClient
// so the feature can be exercised in isolation (`pnpm --filter ./apps/fe7-admin-roster dev`).
import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { gateway } from "@dub/types";
import { RosterProvider } from "./providers/RosterProvider";
import { NavigationProvider, type Navigation } from "./providers/NavigationContext";
import { createMockClient } from "./api/mockClient";
import { routes, nav } from "./routes";
import { usePermissions } from "./hooks/usePermissions";
import { Toaster } from "./ui/Toaster";
import { Button } from "./ui/primitives";

function matchRoute(path: string) {
  for (const r of routes) {
    const rx = new RegExp("^" + r.path.replace(/:[^/]+/g, "([^/]+)") + "$");
    const m = path.match(rx);
    if (m) {
      const names = [...r.path.matchAll(/:([^/]+)/g)].map((x) => x[1]!);
      const params: Record<string, string> = {};
      names.forEach((n, i) => (params[n] = m[i + 1]!));
      return { route: r, params };
    }
  }
  return null;
}

const MOCK_ME: gateway.MeResponse = {
  user: { id: "user_alice", displayName: "Alice Admin", avatarUrl: null },
  orgId: "org_devhub",
  permissions: ["identity:read", "identity:admin", "audit:read", "event:read"],
  sessionExpiresAt: Date.now() + 3600_000,
};

function Sidebar({ navigate }: { navigate: (p: string) => void }) {
  const { canAll } = usePermissions();
  return (
    <nav style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 180 }}>
      {nav.filter((n) => canAll(n.requiredPermissions)).sort((a, b) => a.order - b.order).map((n) => (
        <Button key={n.path} onClick={() => navigate(n.path)} testId={`fe7-nav-${n.icon}`}>{n.label}</Button>
      ))}
    </nav>
  );
}

export function App() {
  const client = useMemo(() => createMockClient({ me: MOCK_ME }), []);
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [path, setPath] = useState("/admin/users");

  const navigation: Navigation = { params: matchRoute(path)?.params ?? {}, navigate: setPath };
  const match = matchRoute(path);
  const Body = match?.route.component;

  return (
    <QueryClientProvider client={qc}>
      <RosterProvider client={client} me={MOCK_ME}>
        <NavigationProvider value={navigation}>
          <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "var(--dub-font-family-sans)" }}>
            <Sidebar navigate={setPath} />
            <main style={{ flex: 1 }} data-testid="fe7-main">{Body ? <Body /> : <p>Not found: {path}</p>}</main>
          </div>
          <Toaster />
        </NavigationProvider>
      </RosterProvider>
    </QueryClientProvider>
  );
}
