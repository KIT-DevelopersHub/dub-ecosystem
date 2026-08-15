// Standalone bootstrap (Phase0). Default: mock ChatApiClient + mock realtime so the
// feature runs without chat-service. Set VITE_CHAT_LIVE=1 to wire the REAL runtime
// (HttpChatClient over the gateway + WsChatClient DO-direct) against a live backend —
// this exercises the same clients FE2 injects in admin-spa. In admin-spa this file is
// replaced by the shell registering `chatFeature` and injecting the real runtime.
/// <reference lib="dom" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import cssText from "@dub/tokens/css";
import "@dub/ui/style.css"; // @dub/ui component CSS (Modal overlay, Avatar, etc.) — standalone only
import type { identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "./context";
import { ChatApp } from "./components/ChatApp";
import type { ChatApiClient } from "./api/client";
import { HttpChatClient } from "./api/client";
import { MockChatClient } from "./api/mock-client";
import type { ChatRealtimeClient } from "./realtime/client";
import { WsChatClient } from "./realtime/ws-client";
import { MockRealtimeClient } from "./realtime/mock-client";
import { demoSeed, ME } from "./dev/seed";

// inject design tokens as CSS variables (light + dark)
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const live = import.meta.env.VITE_CHAT_LIVE === "1" || import.meta.env.VITE_CHAT_LIVE === "true";
const grants: identity.PermissionKey[] = ["chat:create", "chat:moderate"];

// Live: real HTTP client + real DO-direct WS client (fresh ws-ticket per connect,
// fetched through the same api). Mock: in-memory demo seed, no network.
const api: ChatApiClient = live
  ? new HttpChatClient({ baseUrl: import.meta.env.VITE_CHAT_API_BASE ?? "" })
  : new MockChatClient(demoSeed());

const createRealtimeClient: () => ChatRealtimeClient = live
  ? () => new WsChatClient({ getTicket: (channelId) => api.getWsTicket(channelId) })
  : () => new MockRealtimeClient();

const runtime: ChatRuntime = {
  api,
  currentUserId: ME,
  can: (permission) => grants.includes(permission),
  createRealtimeClient,
};

const queryClient = new QueryClient();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ChatRuntimeProvider value={runtime}>
          <ChatApp />
        </ChatRuntimeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
