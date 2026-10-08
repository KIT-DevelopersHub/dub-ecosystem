import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

// ── proactive session refresh ────────────────────────────────────────────────────
// The access token has a fixed TTL, so reacting to 401s alone means the user is ALWAYS
// interrupted at the TTL boundary (the "logged out every hour" report). The provider must
// rotate the cookie BEFORE sessionExpiresAt, and must keep doing so indefinitely.
const HOUR_MS = 60 * 60 * 1000;

function makeRefreshApi(me: () => gateway.MeResponse, refresh: () => Promise<boolean>): ApiClient {
  return { auth: { me: () => Promise.resolve(me()), refresh } } as unknown as ApiClient;
}

describe("proactive session refresh", () => {
  beforeEach(() => {
    // shouldAdvanceTime keeps the fake clock in step with real time so RTL's waitFor (which
    // polls on real timers) still resolves; advanceTimersByTimeAsync then jumps the hour.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules from sessionExpiresAt and rotates ~5 min BEFORE it expires", async () => {
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const me = { ...ME, sessionExpiresAt: Date.now() + HOUR_MS };
    wrap(makeRefreshApi(() => me, refresh), <Status />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    // 54 min in: still well inside the session, nothing rotated yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(54 * 60 * 1000);
    });
    expect(refresh).not.toHaveBeenCalled();

    // Crossing (expiry - 5 min) rotates, so no request ever sees a 401.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-arms from the REFRESHED expiry (not a one-shot timer)", async () => {
    // Regression: without invalidating /me the provider never sees the new sessionExpiresAt,
    // so the timer fires once and the session dies at the next boundary anyway.
    let expiresAt = Date.now() + HOUR_MS;
    const refresh = vi.fn<() => Promise<boolean>>().mockImplementation(async () => {
      expiresAt = Date.now() + HOUR_MS; // server extends the session
      return true;
    });
    wrap(
      makeRefreshApi(() => ({ ...ME, sessionExpiresAt: expiresAt }), refresh),
      <Status />,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(56 * 60 * 1000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Second TTL window: the timer must have been re-armed off the new expiry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(56 * 60 * 1000);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("rotates on visibilitychange when the expiry is already near (throttled background tab)", async () => {
    // A backgrounded tab's timers are throttled or never fire (sleep/suspend) — the
    // "left it open overnight" logout. Becoming visible must rotate immediately.
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const me = { ...ME, sessionExpiresAt: Date.now() + 60_000 }; // inside the 5-min lead
    wrap(makeRefreshApi(() => me, refresh), <Status />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    // Delta, not absolute: a near expiry also floors the backup timer to ~1s, which may or
    // may not have fired by now. What this asserts is that becoming visible rotates at all.
    const before = refresh.mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(refresh.mock.calls.length).toBeGreaterThan(before);
  });

  it("ignores visibilitychange while the session is still far from expiring", async () => {
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const me = { ...ME, sessionExpiresAt: Date.now() + HOUR_MS };
    wrap(makeRefreshApi(() => me, refresh), <Status />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears the timer and the listener on unmount (no leaks, no late rotation)", async () => {
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const me = { ...ME, sessionExpiresAt: Date.now() + HOUR_MS };
    const { unmount } = wrap(makeRefreshApi(() => me, refresh), <Status />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clamps a far-future expiry instead of overflowing setTimeout (int32 -> immediate fire)", async () => {
    // setTimeout stores its delay in an int32: a delay past 2^31-1 ms fires IMMEDIATELY,
    // which would rotate the session in a hot loop. A ~100-day expiry must stay quiet.
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const me = { ...ME, sessionExpiresAt: Date.now() + 100 * 24 * HOUR_MS };
    wrap(makeRefreshApi(() => me, refresh), <Status />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not hot-loop when sessionExpiresAt is ALREADY past", async () => {
    // Negative delay must be floored, and a failed rotation must not re-arm.
    const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const me = { ...ME, sessionExpiresAt: Date.now() - 10_000 };
    wrap(makeRefreshApi(() => me, refresh), <Status />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // One attempt from the floored timer — not a tight loop.
    expect(refresh).toHaveBeenCalledTimes(1);
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
