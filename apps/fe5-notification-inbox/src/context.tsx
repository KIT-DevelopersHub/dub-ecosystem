// FE5 dependency-injection context. In the real SPA these are provided by FE2
// (api-client, router navigate, toast). FE5 consumes them through this context
// so components stay decoupled from FE2 internals and remain unit-testable.

import { createContext, useContext, type ReactNode } from "react";
import type { NotificationApi } from "./api/client";

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  show(kind: ToastKind, message: string): void;
}

export interface NotificationDeps {
  api: NotificationApi;
  navigate: (path: string) => void;
  toast: Toast;
  // Initial unread hint from BFF /home (optional; the truth is useUnreadCount).
  initialUnreadHint?: number;
  // Poll interval override (tests inject a short one).
  pollIntervalMs?: number;
}

const Ctx = createContext<NotificationDeps | null>(null);

export function NotificationProvider(props: {
  deps: NotificationDeps;
  children: ReactNode;
}): ReactNode {
  return <Ctx.Provider value={props.deps}>{props.children}</Ctx.Provider>;
}

export function useNotificationDeps(): NotificationDeps {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotificationDeps must be used within NotificationProvider");
  return v;
}
