// Standalone dev harness (local `pnpm dev` only). In production FE2 mounts the
// FeatureModule; here we provide a minimal hash router + the mock API + a fully
// permissioned session so all screens are explorable. Not part of the contract.
import { StrictMode, useMemo, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cssText } from "@dub/tokens/css";
import { ToastProvider } from "@dub/ui";
import { useAuthStore } from "./contracts/fe2";
import { NavigationProvider, type NavigationApi } from "./contracts/navigation";
import { EventApiProvider, RegistryProvider } from "./context/ApiContext";
import { createMockEventApi } from "./api/mockData";
import { actionTypeRegistry } from "./module";
import { EventListPage } from "./pages/EventListPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { ActionDetailPage } from "./pages/ActionDetailPage";
import { EventSettingsPage } from "./pages/EventSettingsPage";

function matchRoute(path: string): { render: () => JSX.Element; params: Record<string, string> } {
  const detail = path.match(/^\/events\/([^/]+)\/settings$/);
  if (detail) return { render: () => <EventSettingsPage />, params: { eventId: detail[1]! } };
  const action = path.match(/^\/events\/([^/]+)\/actions\/([^/]+)$/);
  if (action) return { render: () => <ActionDetailPage />, params: { eventId: action[1]!, actionId: action[2]! } };
  const ev = path.match(/^\/events\/([^/]+)$/);
  if (ev) return { render: () => <EventDetailPage />, params: { eventId: ev[1]! } };
  return { render: () => <EventListPage />, params: {} };
}

function parseHash(): { path: string; search: string } {
  const raw = window.location.hash.replace(/^#/, "") || "/events";
  const [path, search = ""] = raw.split("?");
  return { path: path || "/events", search };
}

function App() {
  // Dev-only: VITE_MOCK_LATENCY (ms) lets us preview loading/skeleton states
  // (FRONTEND_GUIDE §5). Defaults to 0 so normal `pnpm dev` is instant.
  const latency = Number(import.meta.env.VITE_MOCK_LATENCY ?? 0);
  const api = useMemo(() => createMockEventApi({ events: 3, actionsPerEvent: 4 }, latency), [latency]);
  const [loc, setLoc] = useState(parseHash());
  const setMe = useAuthStore((s) => s.setMe);

  useEffect(() => {
    // Fully permissioned dev session.
    setMe({
      user: { id: "usr_dev", displayName: "開発ユーザー", avatarUrl: null },
      orgId: "org_devhub",
      permissions: ["event:read", "event:write", "event:admin"],
      sessionExpiresAt: Date.now() + 3600_000,
    });
    const onHash = () => setLoc(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [setMe]);

  const nav: NavigationApi = useMemo(
    () => ({
      navigate: (to) => {
        window.location.hash = to;
      },
      params: matchRoute(loc.path).params,
      search: loc.search,
      setSearch: (query) => {
        window.location.hash = `${loc.path}${query ? `?${query}` : ""}`;
      },
    }),
    [loc],
  );

  const { render } = matchRoute(loc.path);

  return (
    <EventApiProvider api={api}>
      <RegistryProvider registry={actionTypeRegistry}>
        <NavigationProvider value={nav}>
          <ToastProvider>{render()}</ToastProvider>
        </NavigationProvider>
      </RegistryProvider>
    </EventApiProvider>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const styleEl = document.createElement("style");
styleEl.textContent = cssText;
document.head.appendChild(styleEl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
