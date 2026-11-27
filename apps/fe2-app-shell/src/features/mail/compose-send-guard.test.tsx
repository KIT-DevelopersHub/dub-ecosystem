// #929: a successful send must land in Sent without the unsaved-changes confirm.
// Uses a real memory router so the UnsavedChangesGuard blocker is actually mounted.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { ToastProvider } from "@dub/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailApi } from "./mailApi.tsx";
import { MailApiProvider } from "./MailProvider.tsx";
import { ComposeScreen } from "./ComposeScreen.tsx";

function renderAt(api: MailApi) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const compose = createRoute({ getParentRoute: () => rootRoute, path: "/mail/compose", component: ComposeScreen });
  const sent = createRoute({ getParentRoute: () => rootRoute, path: "/mail/sent", component: () => <p data-testid="sent-page">sent</p> });
  const inbox = createRoute({ getParentRoute: () => rootRoute, path: "/mail", component: () => <p data-testid="inbox-page">inbox</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([compose, sent, inbox]),
    history: createMemoryHistory({ initialEntries: ["/mail/compose"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MailApiProvider value={api}>
          <RouterProvider router={router} />
        </MailApiProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function fillForm(): Promise<void> {
  await userEvent.type(await screen.findByTestId("fe2-mail-compose-to"), "alice@example.com");
  await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "Subject");
  await userEvent.type(screen.getByTestId("fe2-mail-compose-body"), "Hello");
}

describe("ComposeScreen leave guard (#929)", () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* storage disabled */
    }
  });

  it("goes straight to Sent after a successful send, with no leave confirm", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1", provider: "ses", acceptedAt: "t" });
    const router = renderAt({ send } as unknown as MailApi);
    await fillForm();
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));

    await waitFor(() => expect(router.state.location.pathname).toBe("/mail/sent"));
    expect(await screen.findByTestId("sent-page")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-compose-leave-confirm")).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still confirms when leaving a filled form without sending", async () => {
    const router = renderAt({ send: vi.fn() } as unknown as MailApi);
    await fillForm();
    await act(async () => {
      void router.navigate({ to: "/mail" });
    });

    expect(await screen.findByTestId("fe2-mail-compose-leave-confirm")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/mail/compose");
  });

  it("stays on the form when the send fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const router = renderAt({ send } as unknown as MailApi);
    await fillForm();
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(router.state.location.pathname).toBe("/mail/compose");
    expect((screen.getByTestId("fe2-mail-compose-subject") as HTMLInputElement).value).toBe("Subject");
  });
});
