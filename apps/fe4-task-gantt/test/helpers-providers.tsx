import { useRef, type ReactElement, type ReactNode } from "react";
import { render as rtlRender, type RenderOptions, type RenderResult } from "@testing-library/react";
import { ToastProvider } from "@dub/ui";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";

/**
 * Providers the detail dialog now requires: an ApiClientProvider (the attachments
 * editor fetches a task's attachments) and a ToastProvider (optimistic save/attach
 * feedback). A stable per-tree MockApiClient survives RTL rerenders. Harmless for
 * components that don't consume the context.
 */
function Providers({ children }: { children: ReactNode }) {
  const clientRef = useRef<MockApiClient>();
  if (!clientRef.current) clientRef.current = new MockApiClient();
  return (
    <ApiClientProvider client={clientRef.current}>
      <ToastProvider>{children}</ToastProvider>
    </ApiClientProvider>
  );
}

export function renderWithProviders(ui: ReactElement, opts?: Omit<RenderOptions, "wrapper">): RenderResult {
  return rtlRender(ui, { wrapper: Providers, ...opts });
}
