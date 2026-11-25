import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { member, type gateway } from "@dub/types";
import type { ApiClient, SelfParticipation } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { AppShellLayout } from "./AppShellLayout.tsx";
import { SELF_PARTICIPATION_KEY, summarizeMissing } from "./ProfileReminder.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: [],
  sessionExpiresAt: Date.now() + 60_000,
};

const FULL: SelfParticipation = {
  lastName: "山田", firstName: "太郎", lastNameKana: "やまだ", firstNameKana: "たろう",
  lastNameRomaji: "Yamada", firstNameRomaji: "Taro", schoolEmail: "t@school.ac.jp", gmail: "t@gmail.com",
  phone: "090-0000-0000", grade: "3", department: "情報工学科", rosterNumber: "3EP2-26",
  studentNumber: "1400980", desiredActivity: null, note: null, contact: null, operations: null,
};

function renderShell(part: SelfParticipation, me: gateway.MeResponse = ME) {
  const api = {
    auth: {
      me: () => Promise.resolve(me),
      updateProfile: vi.fn(() => Promise.resolve({ displayName: me.user.displayName, avatarUrl: null })),
      getSelfParticipation: vi.fn(() => Promise.resolve(part)),
      updateSelfParticipation: vi.fn((p: Partial<SelfParticipation>) => Promise.resolve({ ...part, ...p })),
      stopImpersonation: vi.fn(() => Promise.resolve()),
    },
  } as unknown as ApiClient;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider api={api}>
          <AppShellLayout navEntries={[]} api={api} onNavigate={vi.fn()} onLogout={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  const r = render(ui);
  return { qc, api, ...r, remount: () => { r.unmount(); return render(ui); } };
}

describe("profile reminder (#849)", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("shows the banner with the missing fields and a dot on ⚙ / アカウント設定", async () => {
    renderShell({ ...FULL, phone: null, gmail: "  " });
    expect(await screen.findByTestId("fe2-profile-reminder")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-profile-reminder-fields")).toHaveTextContent("Gmail アドレス、電話番号");
    expect(screen.getByTestId("fe2-settings-menu-badge")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-settings-menu-trigger").getAttribute("aria-label")).toContain("未入力");
    await userEvent.click(screen.getByTestId("fe2-settings-menu-trigger"));
    expect(screen.getByTestId("fe2-account-settings-open-badge")).toBeInTheDocument();
  });

  it("opens アカウント設定 in one click from the banner", async () => {
    renderShell({ ...FULL, phone: null });
    await userEvent.click(await screen.findByTestId("fe2-profile-reminder-open"));
    expect(await screen.findByTestId("fe2-account-settings")).toBeInTheDocument();
  });

  it("dismiss hides the banner for this session only; the ⚙ dot stays", async () => {
    const { remount } = renderShell({ ...FULL, phone: null });
    await userEvent.click(await screen.findByTestId("fe2-profile-reminder-dismiss"));
    expect(screen.queryByTestId("fe2-profile-reminder")).toBeNull();
    expect(screen.getByTestId("fe2-settings-menu-badge")).toBeInTheDocument();
    remount();
    expect(await screen.findByTestId("fe2-settings-menu-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-profile-reminder")).toBeNull();
    // 新しいセッション (= Dub を開き直す) では再び出る。
    window.sessionStorage.clear();
    remount();
    expect(await screen.findByTestId("fe2-profile-reminder")).toBeInTheDocument();
  });

  it("shows nothing when every required field is filled", async () => {
    const { api } = renderShell(FULL);
    await waitFor(() => expect(api.auth.getSelfParticipation).toHaveBeenCalled());
    await screen.findByTestId("fe2-settings-menu-trigger");
    expect(screen.queryByTestId("fe2-profile-reminder")).toBeNull();
    expect(screen.queryByTestId("fe2-settings-menu-badge")).toBeNull();
  });

  it("disappears as soon as the saved profile becomes complete (shared cache)", async () => {
    const { qc } = renderShell({ ...FULL, phone: null });
    expect(await screen.findByTestId("fe2-profile-reminder")).toBeInTheDocument();
    act(() => qc.setQueryData(SELF_PARTICIPATION_KEY, FULL));
    await waitFor(() => expect(screen.queryByTestId("fe2-profile-reminder")).toBeNull());
    expect(screen.queryByTestId("fe2-settings-menu-badge")).toBeNull();
  });

  it("stays quiet while impersonating someone", async () => {
    const imp = {
      ...ME,
      impersonation: { actor: { id: "usr_admin", displayName: "Admin" }, expiresAt: Date.now() + 600_000 },
    } as gateway.MeResponse;
    const { api } = renderShell({ ...FULL, phone: null }, imp);
    expect(await screen.findByTestId("fe2-impersonation-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-profile-reminder")).toBeNull();
    expect(api.auth.getSelfParticipation).not.toHaveBeenCalled();
  });
});

describe("summarizeMissing", () => {
  it("lists up to 3 labels then ほか N 件", () => {
    expect(summarizeMissing(["phone"])).toBe("電話番号");
    expect(summarizeMissing([...member.PROFILE_REMINDER_KEYS])).toBe(
      `氏名（苗字）、氏名（名前）、ふりがな（せい） ほか ${member.PROFILE_REMINDER_KEYS.length - 3} 件`,
    );
  });
});
