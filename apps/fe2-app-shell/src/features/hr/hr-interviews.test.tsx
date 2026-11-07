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
  // demo の担当者 (usr_demo) をテストのログイン中の人 (usr_test) に読み替え、自分の枠として扱う。
  const raw = createInterviewsApi(c);
  type O = Awaited<ReturnType<InterviewsApi["overview"]>>;
  const asMe = (p: Promise<O>) =>
    p.then((o) => ({ ...o, slots: o.slots.map((x) => (x.interviewerId === "usr_demo" ? { ...x, interviewerId: "usr_test" } : x)) }));
  const api: InterviewsApi = {
    ...raw,
    overview: () => asMe(raw.overview()),
    addSlots: (b) => asMe(raw.addSlots(b)),
    removeSlots: (b) => asMe(raw.removeSlots(b)),
    removeSlot: (id) => asMe(raw.removeSlot(id)),
    saveSettings: (b) => asMe(raw.saveSettings(b)),
  };
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

/** jsdom は座標を持たないので、指の下のコマを「次に返すコマ」で差し替える。 */
function dragAcross(from: string, to: string): void {
  const grid = screen.getByTestId("fe2-hr-slot-grid");
  const at = (key: string) => {
    document.elementFromPoint = () => screen.getByTestId(`fe2-hr-cell-${key}`);
  };
  at(from);
  fireEvent.pointerDown(grid, { pointerId: 1, button: 0, pointerType: "mouse", clientX: 1, clientY: 1 });
  at(to);
  fireEvent.pointerMove(grid, { pointerId: 1, clientX: 2, clientY: 2 });
  fireEvent.pointerUp(grid, { pointerId: 1 });
}

const mineCount = () => document.querySelectorAll('[data-cell][data-kind="mine"]').length;

describe("面談タブ", () => {
  it("shows the shortfall and held count, then releases once a dragged range fills the candidates", async () => {
    renderScreen();
    await screen.findByTestId("fe2-hr-interviews-status");
    expect(screen.getByTestId("fe2-hr-interviews-open-count").textContent).toBe("3");
    expect(screen.getByTestId("fe2-hr-interviews-status-message").textContent).toContain("2 人への案内メールを保留");
    expect(within(screen.getByTestId("fe2-hr-interviews-invite-table")).getAllByText("メール保留中")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("fe2-hr-grid-next")); // 7 日後から = すべて未来
    expect(mineCount()).toBe(0);
    expect(screen.getByTestId("fe2-hr-grid-commit")).toHaveProperty("disabled", true);
    dragAcross("1:2", "2:3"); // 2 日 × 2 マス = 4 マスを選ぶ (まだ登録しない)
    expect(screen.getByTestId("fe2-hr-grid-selected").textContent).toBe("4 マスを選んでいます");
    expect(mineCount()).toBe(0);
    fireEvent.click(screen.getByTestId("fe2-hr-grid-commit"));
    await waitFor(() => expect(mineCount()).toBe(4));
    await waitFor(() => expect(screen.getByTestId("fe2-hr-interviews-open-count").textContent).toBe("7"));
    expect(screen.getByTestId("fe2-hr-interviews-status-message").textContent).toContain("候補が揃っています");
    expect(within(screen.getByTestId("fe2-hr-interviews-invite-table")).getAllByText("メール送信済み")).toHaveLength(2);

    dragAcross("1:2", "1:3"); // 登録済みを選ぶと「登録を外す」
    expect(screen.getByTestId("fe2-hr-grid-commit").textContent).toBe("登録を外す");
    fireEvent.click(screen.getByTestId("fe2-hr-grid-commit"));
    await waitFor(() => expect(screen.getByTestId("fe2-hr-interviews-open-count").textContent).toBe("5"));
    expect(mineCount()).toBe(2);
  });

  it("adds to the selection over several drags, unselects a clicked cell, and works from the keyboard", async () => {
    renderScreen();
    await screen.findByTestId("fe2-hr-slot-grid");
    fireEvent.click(screen.getByTestId("fe2-hr-grid-next"));
    dragAcross("0:0", "0:1");
    dragAcross("2:4", "2:4");
    expect(screen.getByTestId("fe2-hr-grid-selected").textContent).toBe("3 マスを選んでいます");
    dragAcross("0:0", "0:0"); // 選択済みを押し直すと外れる
    fireEvent.click(screen.getByTestId("fe2-hr-cell-5:0"), { detail: 0 }); // キーボード
    // マウスの click (detail 1) は pointer 側で処理するので二重に数えない
    fireEvent.click(screen.getByTestId("fe2-hr-cell-6:0"), { detail: 1 });
    expect(screen.getByTestId("fe2-hr-grid-selected").textContent).toBe("3 マスを選んでいます");
    fireEvent.click(screen.getByTestId("fe2-hr-grid-clear"));
    expect(screen.getByTestId("fe2-hr-grid-selected").textContent).toBe("マスが選ばれていません");
  });

  it("rolls the painted cells back when the server refuses", async () => {
    let refuse = (_: Error): void => {};
    renderScreen(EDITOR, (api) => ({ ...api, addSlots: () => new Promise((_, reject) => (refuse = reject)) }));
    await screen.findByTestId("fe2-hr-slot-grid");
    fireEvent.click(screen.getByTestId("fe2-hr-grid-next"));
    dragAcross("3:0", "3:5");
    fireEvent.click(screen.getByTestId("fe2-hr-grid-commit"));
    await waitFor(() => expect(mineCount()).toBe(6)); // 応答を待たずに塗る
    refuse(new Error("down"));
    await waitFor(() => expect(mineCount()).toBe(0));
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
    expect(screen.queryByTestId("fe2-hr-interviews-register")).toBeNull();
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
