// Standalone bootstrap (Phase0). Wires the mock ChatApiClient + mock realtime so
// the feature runs without chat-service. In admin-spa this file is replaced by the
// shell registering `chatFeature` and injecting the real runtime.
/// <reference lib="dom" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import cssText from "@dub/tokens/css";
import type { identity } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "./context";
import { ChatApp } from "./components/ChatApp";
import { MockChatClient } from "./api/mock-client";
import { MockRealtimeClient } from "./realtime/mock-client";
import { demoSeed, ME } from "./dev/seed";

// inject design tokens as CSS variables (light + dark)
const style = document.createElement("style");
style.textContent = cssText;
document.head.appendChild(style);

const seed = demoSeed();
const api = new MockChatClient(seed);
const grants: identity.PermissionKey[] = ["chat:create", "chat:moderate"];

const runtime: ChatRuntime = {
  api,
  currentUserId: ME,
  can: (permission) => grants.includes(permission),
  createRealtimeClient: () => new MockRealtimeClient(),
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
