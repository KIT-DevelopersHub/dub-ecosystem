import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { gateway } from "@dub/types";
import { ApiError, type ApiClient } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import { AccountSettingsDialog } from "./AccountSettingsDialog.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: [],
  sessionExpiresAt: Date.now() + 60_000,
};

function setup(updateProfile: ApiClient["auth"]["updateProfile"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.me, ME);
  const shellApi = { auth: { updateProfile, changePassword: vi.fn(() => Promise.resolve()) } } as unknown as ApiClient;
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AccountSettingsDialog api={shellApi} open onClose={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc };
}

describe("AccountSettingsDialog", () => {
  it("optimistically patches the /me cache and calls updateProfile on save", async () => {
    const updateProfile = vi.fn(() => Promise.resolve({ displayName: "コウタ", avatarUrl: null }));
    const { qc } = setup(updateProfile);

    // 表示名 starts from the /me cache.
    const nameInput = screen.getByTestId("fe2-account-name") as HTMLInputElement;
    expect(nameInput.value).toBe("Kota");

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "コウタ");
    await userEvent.click(screen.getByTestId("fe2-account-settings-save"));

    // The server was asked to persist the new display name.
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ displayName: "コウタ", avatarUrl: null }));
    // The /me cache reflects the change (optimistic → reconciled).
    await waitFor(() => {
      const me = qc.getQueryData<gateway.MeResponse>(queryKeys.me);
      expect(me?.user.displayName).toBe("コウタ");
    });
  });

  it("rolls the /me cache back when the save fails", async () => {
    const updateProfile = vi.fn(() =>
      Promise.reject(new ApiError(500, { error: { code: "INTERNAL", message: "boom", retryable: true } })),
    );
    const { qc } = setup(updateProfile);

    const nameInput = screen.getByTestId("fe2-account-name") as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "失敗する名前");
    await userEvent.click(screen.getByTestId("fe2-account-settings-save"));

    // After the rejection the cache is restored to the original display name.
    await waitFor(() => {
      const me = qc.getQueryData<gateway.MeResponse>(queryKeys.me);
      expect(me?.user.displayName).toBe("Kota");
    });
    // An inline error is surfaced.
    expect(await screen.findByTestId("fe2-account-settings-error")).toBeInTheDocument();
  });

  it("clears the avatar to initials with イニシャルに戻す", async () => {
    const updateProfile = vi.fn(() => Promise.resolve({ displayName: "Kota", avatarUrl: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.me, { ...ME, user: { ...ME.user, avatarUrl: "data:image/png;base64,AAA" } });
    const shellApi = { auth: { updateProfile, changePassword: vi.fn(() => Promise.resolve()) } } as unknown as ApiClient;
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AccountSettingsDialog api={shellApi} open onClose={vi.fn()} />
        </ToastProvider>
      </QueryClientProvider>,
    );

    // With an avatar set, the clear button is enabled; clicking it drops to null.
    const clear = screen.getByTestId("fe2-account-avatar-clear");
    expect(clear).not.toBeDisabled();
    await userEvent.click(clear);
    await userEvent.click(screen.getByTestId("fe2-account-settings-save"));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ displayName: "Kota", avatarUrl: null }));
  });
});
