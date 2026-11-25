// 代理表示バナー: 代理中だけ出る / 名前と残り時間 / 「自分に戻る」で stop → 再読込 /
// 期限で自動的に戻る / 代理中は proactive refresh しない (refresh すると代理が終わるため)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { ImpersonationBanner, remainingMinutes } from "./ImpersonationBanner.tsx";

const T0 = Date.parse("2026-11-06T10:00:00Z");

function meOf(impersonating: boolean, expiresAt = T0 + 60 * 60_000): gateway.MeResponse {
  return {
    user: { id: "usr_member", displayName: "メンバー 花子", avatarUrl: null },
    orgId: "org_devhub",
    permissions: ["identity:read"],
    sessionExpiresAt: expiresAt,
    ...(impersonating ? { impersonation: { actor: { id: "usr_admin", displayName: "管理 太郎", avatarUrl: null }, startedAt: T0, expiresAt } } : {}),
  };
}

function setup(me: gateway.MeResponse, now: () => number = () => T0) {
  const stopImpersonation = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const api = { auth: { me: () => Promise.resolve(me), stopImpersonation, refresh } } as unknown as ApiClient;
  const reload = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={api}>
        <ImpersonationBanner api={api} reload={reload} now={now} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { stopImpersonation, refresh, reload };
}

describe("remainingMinutes", () => {
  it("rounds up and never goes negative", () => {
    expect(remainingMinutes(T0 + 60 * 60_000, T0)).toBe(60);
    expect(remainingMinutes(T0 + 61_000, T0)).toBe(2);
    expect(remainingMinutes(T0 + 1_000, T0)).toBe(1);
    expect(remainingMinutes(T0 - 1_000, T0)).toBe(0);
  });
});

describe("ImpersonationBanner", () => {
  it("renders nothing for a normal session", async () => {
    setup(meOf(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("fe2-impersonation-banner")).not.toBeInTheDocument();
  });

  it("shows whose account, the remaining minutes and who is recorded", async () => {
    setup(meOf(true), () => T0 + 15 * 60_000);
    const banner = await screen.findByTestId("fe2-impersonation-banner");
    expect(banner).toHaveTextContent("メンバー 花子さんとして表示中");
    expect(screen.getByTestId("fe2-impersonation-remaining")).toHaveTextContent("残り45分");
    expect(banner).toHaveTextContent("管理 太郎");
    expect(banner).toHaveAttribute("role", "status");
  });

  it("「自分に戻る」 stops the impersonation, then reloads into the admin's own account", async () => {
    const user = userEvent.setup();
    const { stopImpersonation, reload } = setup(meOf(true));
    await user.click(await screen.findByTestId("fe2-impersonation-return"));
    await waitFor(() => expect(stopImpersonation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reload).toHaveBeenCalledWith("/"));
  });

  it("still reloads when stop fails (already ended / own session died)", async () => {
    const user = userEvent.setup();
    const { stopImpersonation, reload } = setup(meOf(true));
    stopImpersonation.mockRejectedValueOnce(new Error("409"));
    await user.click(await screen.findByTestId("fe2-impersonation-return"));
    await waitFor(() => expect(reload).toHaveBeenCalledWith("/"));
  });

  it("returns automatically at the deadline", async () => {
    const { stopImpersonation, reload } = setup(meOf(true), () => T0 + 60 * 60_000);
    await waitFor(() => expect(stopImpersonation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reload).toHaveBeenCalledWith("/"));
  });
});

describe("AuthProvider while impersonating", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("does NOT proactively refresh (a refresh would end the impersonation)", async () => {
    const { refresh } = setup(meOf(true, Date.now() + 60 * 60_000), () => Date.now());
    await screen.findByTestId("fe2-impersonation-banner");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(58 * 60_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
