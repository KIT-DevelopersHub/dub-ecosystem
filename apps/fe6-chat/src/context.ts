// Runtime context: dependencies FE6 receives from the shell (FE2) — the API
// client, `can()` authorization hook, current user id, and the realtime client
// factory. In standalone mode main.tsx wires the mock implementations.
//
// Authored JSX-free (createElement) so this module stays a plain .ts: the root
// tsconfig compiles apps/**/src/*.ts and would reject JSX here without --jsx.
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";
import type { common } from "@dub/types";
import type { ChatApiClient } from "./api/client";
import type { ChatRealtimeClient } from "./realtime/client";
import type { CanFn } from "./shell-contract";

export interface ChatRuntime {
  api: ChatApiClient;
  can: CanFn;
  currentUserId: common.UserId;
  createRealtimeClient: () => ChatRealtimeClient;
  // When true, the display-only typing store is driven by the demo simulator (no chat
  // WS available — standalone mock + the VITE_DEMO shell). A live deployment leaves this
  // false and feeds the typing store from the realtime channel.
  demoLiveness?: boolean;
}

const ChatRuntimeContext = createContext<ChatRuntime | null>(null);

export function ChatRuntimeProvider({ value, children }: { value: ChatRuntime; children: ReactNode }): ReactElement {
  return createElement(ChatRuntimeContext.Provider, { value }, children);
}

export function useChatRuntime(): ChatRuntime {
  const ctx = useContext(ChatRuntimeContext);
  if (!ctx) throw new Error("useChatRuntime must be used within ChatRuntimeProvider");
  return ctx;
}
