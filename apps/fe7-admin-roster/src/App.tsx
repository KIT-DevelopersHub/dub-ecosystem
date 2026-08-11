// Standalone dev harness. NOT part of the production surface (FE2 mounts adminModule
// into its own shell/router). Provides an in-memory navigation + a mock ResourceClient
// so the feature can be exercised in isolation (`pnpm --filter ./apps/fe7-admin-roster dev`).
//
// It mirrors FE2's router behaviour: routes are lazy (React.lazy + Suspense) and
// guarded by each route's `requiredPermissions` via RouteGuard.
import { Suspense, lazy, useMemo, useState, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { gateway } from "@dub/types";
import { Button } from "@dub/ui";
import { RosterProvider } from "./providers/RosterProvider";
import { NavigationProvider, type Navigation } from "./providers/NavigationContext";
import { createMockClient } from "./api/mockClient";
import { createHttpClient } from "./api/httpClient";
import { routes, nav } from "./routes";
import type { FeatureRoute } from "./shell/contract";
import { usePermissions } from "./hooks/usePermissions";
import { RouteGuard } from "./components/RouteGuard";
import { MailRateLimitBanner } from "./components/MailRateLimitBanner";
import { Toaster } from "./ui/Toaster";

function matchRoute(path: string): { route: FeatureRoute; params: Record<string, string> } | null {
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
  // mail:admin lets the harness exercise the Email Routing surfaces (roster sync,
  // address issue) — the mock admin role grants it in production too.
  permissions: ["identity:read", "identity:admin", "audit:read", "event:read", "mail:admin"],
  sessionExpiresAt: Date.now() + 3600_000,
};

function Sidebar({ navigate }: { navigate: (p: string) => void }) {
  const { canAll } = usePermissions();
  // NavEntry has no per-entry permissions (FE2 real shape); derive visibility from
  // the matching route's requiredPermissions.
  const permsOf = (path: string) => routes.find((r) => r.path === path)?.requiredPermissions ?? [];
  return (
    <nav style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 180 }}>
      {nav
        .filter((n) => canAll(permsOf(n.path)))
        .sort((a, b) => a.order - b.order)
        .map((n) => (
          <Button key={n.path} variant="secondary" onClick={() => navigate(n.path)} testId={`fe7-nav-${n.icon}`}>
            {n.label}
          </Button>
        ))}
    </nav>
  );
}

export function App() {
  // Default: in-memory mock so the harness runs offline. Set VITE_ROSTER_API_BASE
  // (e.g. "http://localhost:8787") to exercise the real fetch client against a
  // live/stub gateway — the same createHttpClient FE2 wires in production.
  const apiBase = import.meta.env.VITE_ROSTER_API_BASE as string | undefined;
  const client = useMemo(
    () => (apiBase ? createHttpClient({ baseUrl: apiBase }) : createMockClient({ me: MOCK_ME })),
    [apiBase],
  );
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [path, setPath] = useState("/admin/users");

  const match = matchRoute(path);
  const navigation: Navigation = { params: match?.params ?? {}, navigate: setPath };

  // Keyed by route.path so navigating within the same route (e.g. a different
  // :userId) does not remount the lazy body.
  const Body: ComponentType | null = useMemo(
    () => (match ? lazy(() => match.route.lazy().then((m) => ({ default: m.Component }))) : null),
    [match?.route.path],
  );

  return (
    <QueryClientProvider client={qc}>
      <RosterProvider client={client} me={MOCK_ME}>
        <NavigationProvider value={navigation}>
          {/* Persistent rate-limit banner pinned to the top of the admin shell. */}
          <div style={{ padding: "24px 24px 0", fontFamily: "var(--dub-font-family-sans)" }} data-testid="fe7-shell-top">
            <MailRateLimitBanner />
          </div>
          <div style={{ display: "flex", gap: 24, padding: 24, fontFamily: "var(--dub-font-family-sans)" }}>
            <Sidebar navigate={setPath} />
            <main style={{ flex: 1 }} data-testid="fe7-main">
              {Body && match ? (
                <RouteGuard requiredPermissions={match.route.requiredPermissions ?? []}>
                  <Suspense fallback={<p>読み込み中…</p>}>
                    <Body />
                  </Suspense>
                </RouteGuard>
              ) : (
                <p>Not found: {path}</p>
              )}
            </main>
          </div>
          <Toaster />
        </NavigationProvider>
      </RosterProvider>
    </QueryClientProvider>
  );
}
