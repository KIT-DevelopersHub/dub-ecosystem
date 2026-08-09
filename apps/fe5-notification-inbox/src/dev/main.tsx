// Dev harness: mounts FE5 against the mock api-client, standing in for the FE2
// shell. Not part of the shipped package (index.ts is the package surface).

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { cssText } from "@dub/tokens/css";
import { createNotificationApi } from "../api/client";
import { createMockApiClient } from "../api/mock-client";
import { NotificationProvider, type NotificationDeps } from "../context";
import { NotificationInboxPage } from "../components/NotificationInboxPage";
import { NotificationPreferencesPage } from "../components/NotificationPreferencesPage";
import { NotificationBell } from "../components/NotificationBell";
import { ROUTE_PREFERENCES } from "../lib/routes";

const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const api = createNotificationApi(createMockApiClient());
const deps: NotificationDeps = {
  api,
  navigate: (path) => window.history.pushState(null, "", path),
  toast: { show: (kind, msg) => console.info(`[toast:${kind}] ${msg}`) },
  initialUnreadHint: 3,
};

function DevApp(): React.ReactNode {
  const [route, setRoute] = useState<"inbox" | "prefs">("inbox");
  return (
    <NotificationProvider deps={deps}>
      <header style={{ display: "flex", justifyContent: "space-between", padding: 16 }}>
        <nav style={{ display: "flex", gap: 12 }}>
          <button onClick={() => setRoute("inbox")}>Inbox</button>
          <button onClick={() => setRoute("prefs")}>Settings</button>
        </nav>
        <NotificationBell />
      </header>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
        {route === "inbox" ? <NotificationInboxPage /> : <NotificationPreferencesPage />}
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
