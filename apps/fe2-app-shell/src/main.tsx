// Admin SPA entry. Wires the api-client, registers FeatureModules (FE3-FE7 add
// theirs here as they ship), builds the router and mounts it inside AppRoot's
// providers. Distribution: Workers static assets (provisional, theme5 4-4).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { actionTypeRegistry } from "@dub/fe3-event-action";
import { registerTaskActionPlugin } from "@dub/fe4-task-gantt/src/features/task-gantt/public";
import { createApiClient } from "./lib/api-client.tsx";
import { registerFeatureModules } from "./modules/registry.tsx";
import { assembleFeatureModules } from "./composition/index.tsx";
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

// FE4 registers its `task_management` action-type plugin into FE3's app-global
// ActionTypeRegistry singleton before the modules are assembled (design 2-3).
// FE3's registry and FE4's expected registry are the same ActionTypeRegistry
// shape; they differ only in the breadth of their IconName mirror, so bridge the
// nominal type gap with a cast.
registerTaskActionPlugin(actionTypeRegistry as unknown as Parameters<typeof registerTaskActionPlugin>[0]);

// Assemble FE3-FE7 into the shell FeatureModule array (each feature's routes
// wrapped in its runtime Provider, fed by the one shell api-client) and register.
const registry = registerFeatureModules(assembleFeatureModules(api));

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
