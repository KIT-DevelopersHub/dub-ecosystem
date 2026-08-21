import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { gateway } from "@dub/types";
import { ApiError, type ApiClient, type SelfParticipation } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";
import { AccountSettingsDialog } from "./AccountSettingsDialog.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: [],
  sessionExpiresAt: Date.now() + 60_000,
};

const PART: SelfParticipation = {
  lastName: "高岡", firstName: "己太朗", lastNameKana: null, firstNameKana: null,
  lastNameRomaji: null, firstNameRomaji: null, schoolEmail: "kota@school.ac.jp", gmail: "kota@gmail.com",
  phone: "090-0000-0000", grade: "3", department: "情報工学科", desiredActivity: "both", note: null,
};

function setup(
  updateProfile: ApiClient["auth"]["updateProfile"],
  opts: { updateSelfParticipation?: ApiClient["auth"]["updateSelfParticipation"] } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.me, ME);
  const updateSelfParticipation = opts.updateSelfParticipation ?? vi.fn((p: Partial<SelfParticipation>) => Promise.resolve({ ...PART, ...p }));
  const shellApi = {
    auth: {
      updateProfile,
      changePassword: vi.fn(() => Promise.resolve()),
      getSelfParticipation: vi.fn(() => Promise.resolve(PART)),
      updateSelfParticipation,
    },
  } as unknown as ApiClient;
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AccountSettingsDialog api={shellApi} open onClose={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc, updateSelfParticipation };
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

  it("loads the 参加届 fields and saves an edit without touching the profile", async () => {
    const updateProfile = vi.fn(() => Promise.resolve({ displayName: "Kota", avatarUrl: null }));
    const { updateSelfParticipation } = setup(updateProfile);

    // The participation section loads and pre-fills the seeded submission.
    const dept = (await screen.findByTestId("fe2-part-department")) as HTMLInputElement;
    await waitFor(() => expect(dept.value).toBe("情報工学科"));

    await userEvent.clear(dept);
    await userEvent.type(dept, "電気電子工学科");
    await userEvent.click(screen.getByTestId("fe2-account-settings-save"));

    // The 参加届 update carries the edited field (full patched set from the single-source form).
    await waitFor(() => expect(updateSelfParticipation).toHaveBeenCalled());
    const arg = (updateSelfParticipation as unknown as { mock: { calls: Array<[Partial<SelfParticipation>]> } }).mock.calls[0]![0];
    expect(arg.department).toBe("電気電子工学科");
    expect(arg.lastName).toBe("高岡"); // unchanged fields still sent
    // Profile was untouched → updateProfile not called.
    expect(updateProfile).not.toHaveBeenCalled();
  });
});
