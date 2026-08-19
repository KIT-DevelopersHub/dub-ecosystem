// Admin SPA entry. Wires the api-client, registers FeatureModules (FE3-FE7 add
// theirs here as they ship), builds the router and mounts it inside AppRoot's
// providers. Distribution: Workers static assets (provisional, theme5 4-4).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
// Global styles — order matters: token custom properties (:root + [data-theme]),
// then the @dub/ui component rules that consume them, then FE2's own base/reset
// and shell chrome. Without these three the SPA renders as unstyled markup
// (component class names present, no stylesheet defining them).
import "@dub/tokens/tokens.css";
import "@dub/ui/style.css";
import "./styles/global.css";
import { actionTypeRegistry } from "@dub/fe3-event-action";
// FE4 deep-import surface via the single boundary (composition/featureEntries.tsx).
import { registerTaskActionPlugin } from "./composition/featureEntries.tsx";
import { createApiClient } from "./lib/api-client.tsx";
import { resolveBaseUrl } from "./lib/resolve-base-url.tsx";
import { createMockFetch, isMockEnabled } from "./lib/mock-api-client.tsx";
import { createDemoFetch, isDemoEnabled } from "./lib/demo-seed.tsx";
import { registerFeatureModules } from "./modules/registry.tsx";
import { assembleFeatureModules } from "./composition/index.tsx";
import { AppRoot } from "./shell/AppRoot.tsx";
import { createShellRouter } from "./shell/router.tsx";
import { reloadForStaleChunk } from "./lib/chunkReload.ts";

// Recover from a stale hashed chunk after a deploy at the earliest point: Vite
// dispatches `vite:preloadError` when a dynamic import / modulepreload 404s
// (old chunk name removed by the new deploy). Reload once to fetch the fresh
// index.html instead of letting the route render a "Something went wrong!"
// (the 通知 / メール名簿 が開けない incident). The loop guard prevents reload-spin.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForStaleChunk()) event.preventDefault();
  });
}

// Resolve the API base baked in at build time. Defaults to the live free-tier
// gateway on workers.dev and hard-refuses the known-NXDOMAIN custom domain
// api.developershub.jp — a mis-set CI variable pointing there shipped a prod
// bundle whose every /api call (login included) died with ERR_NAME_NOT_RESOLVED.
// See lib/resolve-base-url.tsx for the full incident note.
const baseUrl = resolveBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);

// Backend-free transports (only fetch is swapped; the real api-client logic runs
// unchanged). Two opt-in flags, default (both unset) keeps the prod gateway wiring:
//   VITE_DEMO=1     → demo transport: auto-login + seeded events/tasks/gantt/
//                     notifications/mail/roster, so every nav item is clickable.
//   VITE_API_MOCK=1 → boot-only offline mock (dashboard surface; feature routes 404).
const useDemo = isDemoEnabled(import.meta.env as { VITE_DEMO?: string });
const useMock = !useDemo && isMockEnabled(import.meta.env as { VITE_API_MOCK?: string });
const fetchOverride = useDemo ? createDemoFetch() : useMock ? createMockFetch() : undefined;

let redirectAfterLogin = "/";

const api = createApiClient({
  baseUrl,
  requestIdFactory: () => crypto.randomUUID(),
  ...(fetchOverride ? { fetchImpl: fetchOverride } : {}),
  onUnauthenticated: () => {
    // The public 参加届 form is anonymous by design: a 401 there (e.g. the global /me
    // probe, or the optional teams lookup) must NOT bounce the visitor to /login.
    if (globalThis.location.pathname.startsWith("/participate")) return;
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

// Demo builds carry a persistent banner so viewers know the data is mocked and
// nothing (mail included) is really sent. Injected outside React so it survives
// route changes and never touches feature code.
if (useDemo && typeof document !== "undefined") {
  const banner = document.createElement("div");
  banner.textContent = "デモモード — 表示中のデータはすべてサンプルです（バックエンド未接続・メール等は実際には送信されません）";
  banner.setAttribute("role", "note");
  banner.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:6px 12px;font-size:12px;text-align:center;background:#7c2d12;color:#fff;font-family:system-ui,sans-serif";
  document.body.appendChild(banner);
}

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
