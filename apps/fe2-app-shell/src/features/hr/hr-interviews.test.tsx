// 人事 → 面談タブ + 公開の日程選択 (demo transport 経由):
//   候補数と保留の表示 / 枠の追加で保留が解ける / 設定の変更 / 閲覧者は書き込めない / 枠の削除の失敗で戻る /
//   公開ページで日程を選ぶと確定画面 / 不正な URL の案内
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { describe, expect, it, vi } from "vitest";
import { editorPermissions, FakeAuthProvider, viewerPermissions } from "../../auth/test-support.tsx";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { HrApiProvider } from "./HrProvider.tsx";
import { createHrApi } from "./hrApi.tsx";
import { HrInterviewsScreen } from "./HrInterviewsScreen.tsx";
import { createInterviewsApi, InterviewsApiProvider, type InterviewsApi } from "./interviewsApi.tsx";
import { PublicInterviewBookingPage } from "./PublicInterviewBookingPage.tsx";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useRouter: () => null }));

const EDITOR = editorPermissions("hr", ["hr:read", "hr:write", "hr:admin"]);
const VIEWER = viewerPermissions("hr", ["hr:read"]);

const client = () => createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() });

function renderScreen(perms = EDITOR, tweak?: (api: InterviewsApi) => InterviewsApi) {
  const c = client();
  const api = createInterviewsApi(c);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <FakeAuthProvider permissions={perms}>
          <HrApiProvider value={createHrApi(c)}>
            <InterviewsApiProvider value={tweak ? tweak(api) : api}>
              <HrInterviewsScreen />
            </InterviewsApiProvider>
          </HrApiProvider>
        </FakeAuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function renderBooking(hash: string) {
  window.location.hash = hash;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PublicInterviewBookingPage api={client()} />
    </QueryClientProvider>,
  );
}

async function addSlot(day: number): Promise<void> {
  fireEvent.change(screen.getByTestId("fe2-hr-slot-start"), { target: { value: `2030-01-${String(day).padStart(2, "0")}T14:00` } });
  fireEvent.click(screen.getByTestId("fe2-hr-slot-add"));
}

describe("面談タブ", () => {
  it("shows the shortfall and held count, then releases once enough slots are added", async () => {
    renderScreen();
    await screen.findByTestId("fe2-hr-interviews-status");
    expect(screen.getByTestId("fe2-hr-interviews-open-count").textContent).toBe("3");
    expect(screen.getByTestId("fe2-hr-interviews-status-message").textContent).toContain("2 人への案内メールを保留");
    expect(within(screen.getByTestId("fe2-hr-interviews-invite-table")).getAllByText("メール保留中")).toHaveLength(2);

    await addSlot(1);
    await waitFor(() => expect(screen.getByTestId("fe2-hr-interviews-open-count").textContent).toBe("4"));
    await addSlot(2);
    await waitFor(() => expect(screen.getByTestId("fe2-hr-interviews-status-message").textContent).toContain("候補が揃っています"));
    expect(within(screen.getByTestId("fe2-hr-interviews-invite-table")).getAllByText("メール送信済み")).toHaveLength(2);
  });

  it("lowering the setting releases held invites", async () => {
    renderScreen();
    fireEvent.change(await screen.findByTestId("fe2-hr-interviews-min"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("fe2-hr-interviews-min-save"));
    await waitFor(() => expect(screen.getByTestId("fe2-hr-interviews-status-message").textContent).toContain("候補が揃っています"));
  });

  it("rejects an out-of-range setting", async () => {
    renderScreen();
    fireEvent.change(await screen.findByTestId("fe2-hr-interviews-min"), { target: { value: "0" } });
    expect(screen.getByTestId("fe2-hr-interviews-min-save")).toHaveProperty("disabled", true);
  });

  it("removes a slot optimistically and restores it when the server refuses", async () => {
    let refuse = (_: Error): void => {};
    const pending = new Promise<never>((_, reject) => {
      refuse = reject;
    });
    renderScreen(EDITOR, (api) => ({ ...api, removeSlot: () => pending }));
    const table = await screen.findByTestId("fe2-hr-interviews-slot-table");
    fireEvent.click(within(table).getAllByRole("button", { name: "削除" })[0]!);
    await waitFor(() => expect(within(table).getAllByRole("button", { name: "削除" })).toHaveLength(2));
    refuse(new Error("down"));
    await waitFor(() => expect(within(table).getAllByRole("button", { name: "削除" })).toHaveLength(3));
  });

  it("gives a viewer no write controls", async () => {
    renderScreen(VIEWER);
    await screen.findByTestId("fe2-hr-interviews-status");
    expect(screen.queryByTestId("fe2-hr-slot-add")).toBeNull();
    expect(screen.queryByTestId("fe2-hr-interviews-min")).toBeNull();
    expect(screen.queryByRole("button", { name: "今すぐ送る" })).toBeNull();
  });
});

describe("公開の日程選択", () => {
  it("books the picked slot and shows the confirmation", async () => {
    renderBooking("#t=demo");
    const card = await screen.findByTestId("interview-booking-card");
    expect(screen.getByTestId("interview-booking-submit")).toHaveProperty("disabled", true);
    fireEvent.click(within(card).getAllByRole("radio")[1]!);
    fireEvent.click(screen.getByTestId("interview-booking-submit"));
    expect((await screen.findByTestId("interview-booking-done-at")).textContent).toContain("14:00〜14:30");
  });

  it("explains an invalid link", async () => {
    renderBooking("#t=wrong");
    await screen.findByTestId("interview-booking-invalid");
    window.location.hash = "";
  });
});
