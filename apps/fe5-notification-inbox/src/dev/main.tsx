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
import { NotificationBell } from "../components/NotificationBell";
import { ReleasePublishForm } from "../components/ReleasePublishForm";
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

  const mock = createMockApiClient();
  return {
    api: createNotificationApi(mock),
    navigate,
    toast,
    initialUnreadHint: 3,
    unreadLiveConnect: createMockUnreadConnector(
      () => mock.__store.items.filter((i) => i.readAt === null).length,
    ),
  };
}

const deps = buildDeps();

function DevApp(): React.ReactNode {
  const [route, setRoute] = useState<"inbox" | "prefs" | "publish">("inbox");
  return (
    <NotificationProvider deps={deps}>
      <header style={{ display: "flex", justifyContent: "space-between", padding: 16 }}>
        <nav style={{ display: "flex", gap: 12 }}>
          <button onClick={() => setRoute("inbox")}>Inbox</button>
          <button onClick={() => setRoute("prefs")}>Settings</button>
          <button onClick={() => setRoute("publish")}>Publish (admin)</button>
        </nav>
        <NotificationBell />
      </header>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
        {route === "inbox" ? (
          <NotificationInboxPage />
        ) : route === "prefs" ? (
          <NotificationPreferencesPage />
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
