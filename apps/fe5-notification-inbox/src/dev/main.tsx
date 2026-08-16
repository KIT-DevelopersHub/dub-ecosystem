// Dev harness: mounts FE5 standing in for the FE2 shell. By default it runs
// against the in-memory mock api-client (no server needed). Append `?api=real`
// to drive the REAL notification gateway through createHttpApiClient — the same
// path the SPA shell uses — reading base URL / token from Vite env. A live
// unread-count connector is wired in both modes so the bell badge updates via
// push (SSE against the gateway when real; a store-backed simulator when mock).

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { common } from "@dub/types";
import { cssText } from "@dub/tokens/css";
// Load the @dub/ui design-system component stylesheet (same sheet the FE2 shell
// imports in its main.tsx) so the standalone dev harness renders with ecosystem
// design (tokens → component rules) instead of unstyled native HTML.
import "@dub/ui/style.css";
import { createNotificationApi } from "../api/client";
import { createMockApiClient } from "../api/mock-client";
import { createHttpApiClient } from "../api/http-client";
import {
  createSseUnreadConnector,
  type LiveConnector,
} from "../lib/unread-live";
import { NotificationProvider, type NotificationDeps } from "../context";
import { NotificationInboxPage } from "../components/NotificationInboxPage";
import { NotificationPreferencesPage } from "../components/NotificationPreferencesPage";
import { NotificationManagePage } from "../components/NotificationManagePage";
import { NotificationBell } from "../components/NotificationBell";
import { ReleasePublishForm } from "../components/ReleasePublishForm";
import type { MockViewer } from "../api/mock-client";
import { ROUTE_PREFERENCES } from "../lib/routes";

const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const env = import.meta.env as Record<string, string | undefined>;
const useReal = new URLSearchParams(window.location.search).get("api") === "real";
const STREAM_PATH = `${common.API_PREFIX}/notifications/inbox/stream`;

// Simulate server pushes off the mock store so the dev badge moves without a
// backend: emit the current unread count on an interval (and once on connect).
function createMockUnreadConnector(getUnread: () => number): LiveConnector {
  return (handlers) => {
    handlers.onOpen?.();
    handlers.onCount(getUnread());
    const id = window.setInterval(() => handlers.onCount(getUnread()), 4000);
    return {
      close() {
        window.clearInterval(id);
      },
    };
  };
}

// The mock instance is hoisted (mock mode only) so the dev harness can flip the viewer
// role (admin/member) — used by the E2E to prove audience separation in the inbox.
const mock = useReal ? null : createMockApiClient();

function buildDeps(): NotificationDeps {
  const navigate = (path: string): void => window.history.pushState(null, "", path);
  const toast = { show: (kind: string, msg: string) => console.info(`[toast:${kind}] ${msg}`) };

  if (useReal) {
    const client = createHttpApiClient({
      baseUrl: env.VITE_API_BASE_URL ?? "",
      getAuthToken: () => env.VITE_API_TOKEN ?? null,
    });
    return {
      api: createNotificationApi(client),
      navigate,
      toast,
      unreadLiveConnect: createSseUnreadConnector({
        url: `${env.VITE_API_BASE_URL ?? ""}${STREAM_PATH}`,
        withCredentials: true,
      }),
    };
  }

  const m = mock!;
  return {
    api: createNotificationApi(m),
    navigate,
    toast,
    initialUnreadHint: 3,
    unreadLiveConnect: createMockUnreadConnector(
      () => m.__store.items.filter((i) => i.readAt === null).length,
    ),
  };
}

const deps = buildDeps();

function DevApp(): React.ReactNode {
  const [route, setRoute] = useState<"inbox" | "prefs" | "publish" | "manage">("inbox");
  const [viewer, setViewer] = useState<MockViewer>(mock?.__store.viewer ?? "admin");

  const switchViewer = (v: MockViewer): void => {
    setViewer(v);
    mock?.__setViewer(v);
  };

  return (
    <NotificationProvider deps={deps}>
      <header style={{ display: "flex", justifyContent: "space-between", padding: 16 }}>
        <nav style={{ display: "flex", gap: 12 }}>
          <button onClick={() => setRoute("inbox")}>Inbox</button>
          <button onClick={() => setRoute("prefs")}>Settings</button>
          <button onClick={() => setRoute("manage")}>Notification管理</button>
          <button onClick={() => setRoute("publish")}>Publish (admin)</button>
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {mock ? (
            <span data-testid="dev-viewer-toggle" style={{ display: "flex", gap: 6 }}>
              <button data-testid="dev-view-admin" aria-pressed={viewer === "admin"} onClick={() => switchViewer("admin")}>
                Admin view
              </button>
              <button data-testid="dev-view-member" aria-pressed={viewer === "member"} onClick={() => switchViewer("member")}>
                Member view
              </button>
            </span>
          ) : null}
          <NotificationBell />
        </div>
      </header>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
        {route === "inbox" ? (
          <NotificationInboxPage />
        ) : route === "prefs" ? (
          <NotificationPreferencesPage />
        ) : route === "manage" ? (
          <NotificationManagePage />
        ) : (
          <ReleasePublishForm onPublished={() => setRoute("inbox")} />
        )}
      </main>
    </NotificationProvider>
  );
}

void ROUTE_PREFERENCES;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevApp />
  </StrictMode>,
);
