import { useRef, type ReactElement, type ReactNode } from "react";
import { fireEvent, render as rtlRender, screen, type RenderOptions, type RenderResult } from "@testing-library/react";
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

/**
 * 担当は必須: pick the first offered 担当 (person or team) in a create form whose
 * picker testId is `${prefix}-assignee` — for tests that render without a current user
 * (no default assignee) and only care about the rest of the form.
 */
export function pickFirstAssignee(prefix = "fe4-create"): void {
  fireEvent.click(screen.getByTestId(`${prefix}-assignee-trigger`));
  const first = document.querySelector<HTMLElement>(`[data-testid^="${prefix}-assignee-option-"]`);
  if (!first) throw new Error("pickFirstAssignee: no 担当 options offered");
  fireEvent.click(first);
}
