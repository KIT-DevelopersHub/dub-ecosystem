// Admin SPA entry. Wires the api-client, registers FeatureModules (FE3-FE7 add
// theirs here as they ship), builds the router and mounts it inside AppRoot's
// providers. Distribution: Workers static assets (provisional, theme5 4-4).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createApiClient } from "./lib/api-client.tsx";
import { registerFeatureModules } from "./modules/registry.tsx";
import { AppRoot } from "./shell/AppRoot.tsx";
import { createShellRouter } from "./shell/router.tsx";

const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "https://api.developershub.jp";

let redirectAfterLogin = "/";

const api = createApiClient({
  baseUrl,
  requestIdFactory: () => crypto.randomUUID(),
  onUnauthenticated: () => {
    redirectAfterLogin = globalThis.location.pathname + globalThis.location.search;
    router.navigate({ to: "/login" });
  },
});

// FE3-FE7 register their FeatureModule objects here as they ship.
const registry = registerFeatureModules([]);

const router = createShellRouter(api, registry, {
  onNavigate: (path) => {
    router.navigate({ to: path });
  },
  onLogout: () => {
    void api.auth.logout().finally(() => router.navigate({ to: "/login" }));
  },
});

void redirectAfterLogin;

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppRoot api={api}>
        <RouterProvider router={router} />
      </AppRoot>
    </StrictMode>,
  );
}
