import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider, RequireAuth, RequirePermission, useAuth } from "./AuthProvider.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null },
  orgId: "org_devhub",
  permissions: ["identity:read"],
  sessionExpiresAt: Date.now() + 60_000,
};

function makeApi(me: () => Promise<gateway.MeResponse>): ApiClient {
  return { auth: { me } } as unknown as ApiClient;
}

function wrap(api: ApiClient, ui: ReactNode, onUnauthenticated?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={api} {...(onUnauthenticated ? { onUnauthenticated } : {})}>
        {ui}
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function Status() {
  const s = useAuth();
  return <div data-testid="status">{s.status}</div>;
}

describe("auth guards", () => {
  it("transitions loading -> authenticated", async () => {
    wrap(makeApi(() => Promise.resolve(ME)), <Status />);
    expect(screen.getByTestId("status").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
  });

  it("RequirePermission is fail-closed while loading, then allows when permitted", async () => {
    wrap(
      makeApi(() => Promise.resolve(ME)),
      <RequirePermission permission="identity:read" fallback={<span data-testid="denied">denied</span>}>
        <span data-testid="allowed">allowed</span>
      </RequirePermission>,
    );
    // while /me pending -> fail-closed -> fallback
    expect(screen.getByTestId("denied")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("allowed")).toBeInTheDocument());
  });

  it("RequirePermission denies a permission the user lacks", async () => {
    wrap(
      makeApi(() => Promise.resolve(ME)),
      <RequirePermission permission="identity:admin" fallback={<span data-testid="denied">denied</span>}>
        <span data-testid="allowed">allowed</span>
      </RequirePermission>,
    );
    // identity:admin not granted -> stays denied even after /me resolves
    await waitFor(() => expect(screen.getByTestId("denied")).toBeInTheDocument());
    expect(screen.queryByTestId("allowed")).toBeNull();
  });

  it("RequireAuth fires onUnauthenticated and renders nothing when unauthenticated", async () => {
    const onUnauth = vi.fn();
    wrap(
      makeApi(() => Promise.reject(new Error("401"))),
      <RequireAuth loadingFallback={<span>loading</span>}>
        <span data-testid="secret">secret</span>
      </RequireAuth>,
      onUnauth,
    );
    await waitFor(() => expect(onUnauth).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("secret")).toBeNull();
  });
});
