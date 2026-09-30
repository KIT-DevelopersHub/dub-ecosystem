import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider, RequireAuth, RequirePermission, useAuth, useAppCapability } from "./AuthProvider.tsx";

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

// ── policy layer: per-app capability flags (無効/閲覧/編集) ──────────────────────
// These flags are what every feature uses to disable write controls, so they must be
// fail-closed while /me is in flight and must agree with the server's derivation.
describe("useAppCapability (policy flags)", () => {
  function Caps({ appId }: { appId: string }) {
    const cap = useAppCapability(appId);
    return <div data-testid="caps">{`${cap.level}|${cap.canView}|${cap.canEdit}|${cap.readOnly}`}</div>;
  }

  it("fail-closed (無効) while /me is loading, then resolves the level", async () => {
    const me: gateway.MeResponse = { ...ME, permissions: ["app:tasks:view"] };
    wrap(makeApi(() => Promise.resolve(me)), <Caps appId="tasks" />);
    expect(screen.getByTestId("caps").textContent).toBe("none|false|false|false");
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("view|true|false|true"));
  });

  it("編集 clears readOnly; an unknown app id stays fail-closed", async () => {
    const me: gateway.MeResponse = { ...ME, permissions: ["app:tasks:view", "app:tasks:edit"] };
    const { unmount } = wrap(makeApi(() => Promise.resolve(me)), <Caps appId="tasks" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("edit|true|true|false"));
    unmount();
    wrap(makeApi(() => Promise.resolve(me)), <Caps appId="ghost-app" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("none|false|false|false"));
  });

  it("prefers the server-derived appAccess map when /me carries it", async () => {
    // permissions say 閲覧, the server map says 編集 → the server wins (it is authoritative).
    const me: gateway.MeResponse = { ...ME, permissions: ["app:tasks:view"], appAccess: { tasks: "edit" } };
    wrap(makeApi(() => Promise.resolve(me)), <Caps appId="tasks" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("edit|true|true|false"));
  });

  it("falls back to local derivation for an app the server map omits (deploy skew)", async () => {
    const me: gateway.MeResponse = { ...ME, permissions: ["app:chat:view", "app:chat:edit"], appAccess: { tasks: "none" } };
    wrap(makeApi(() => Promise.resolve(me)), <Caps appId="chat" />);
    await waitFor(() => expect(screen.getByTestId("caps").textContent).toBe("edit|true|true|false"));
  });
});
