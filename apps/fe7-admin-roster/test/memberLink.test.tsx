// メール名簿 ↔ 運営メンバー 紐付け (逆方向) の回帰テスト。UserListPage の「運営メンバー」列と
// MemberLinkDialog を、契約準拠の in-memory mock 越しに検証する:
//  - 未紐付けメールに「運営メンバーと紐付け」ボタン / 紐付け済みメールに運営メンバー名バッジ
//  - ダイアログで運営メンバーを選択→紐付け→楽観的に列へ反映
//  - 既に別アカウントに紐付いた運営メンバーはピッカーで選択不可 (1:1 ガード)
//  - 紐付け解除でボタンへ戻る
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserListPage } from "../src/components/UserListPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";
import { createMockClient } from "../src/api/mockClient";
import { useToastStore } from "../src/hooks/useToast";

describe("メール名簿 ↔ 運営メンバー 紐付け", () => {
  it("未紐付けメールにボタン・紐付け済みメールに運営メンバー名バッジを表示", async () => {
    renderWithProviders(<UserListPage />);
    // Bob は member_bob(佐藤 太郎)に紐付け済み → バッジ
    const bobCell = await screen.findByTestId("fe7-users-member-user_bob");
    expect(within(bobCell).getByText("佐藤 太郎")).toBeInTheDocument();
    // Carol は未紐付け → ボタン
    expect(await screen.findByTestId("fe7-users-member-link-user_carol")).toBeInTheDocument();
  });

  it("運営メンバーを選択して紐付けると列に反映され、解除で戻る", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserListPage />);
    await user.click(await screen.findByTestId("fe7-users-member-link-user_carol"));

    // ダイアログ: 既に紐付け済みの佐藤 太郎(member_bob)は選択不可
    const dialog = await screen.findByTestId("fe7-member-link-dialog");
    expect(within(dialog).getByTestId("fe7-member-link-option-member_bob")).toBeDisabled();

    // 山田 花子 を選び紐付け
    await user.click(within(dialog).getByTestId("fe7-member-link-option-member_hanako"));
    await user.click(within(dialog).getByTestId("fe7-member-link-confirm"));

    const carolCell = await screen.findByTestId("fe7-users-member-user_carol");
    await waitFor(() => expect(within(carolCell).getByText("山田 花子")).toBeInTheDocument());

    // 解除 → ボタンへ戻る
    await user.click(within(carolCell).getByTestId("fe7-users-member-unlink-user_carol"));
    await waitFor(() => expect(screen.getByTestId("fe7-users-member-link-user_carol")).toBeInTheDocument());
  });

  it("read-only ユーザーには紐付け/解除ボタンを出さない (identity:admin 限定)", async () => {
    renderWithProviders(<UserListPage />, { me: makeMe(["identity:read"]) });
    // 紐付け済みメンバー名は読めるが、操作ボタンは出ない
    const bobCell = await screen.findByTestId("fe7-users-member-user_bob");
    expect(within(bobCell).getByText("佐藤 太郎")).toBeInTheDocument();
    expect(within(bobCell).queryByTestId("fe7-users-member-unlink-user_bob")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-users-member-link-user_carol")).not.toBeInTheDocument();
  });

  it("Gmail のある運営メンバーと紐付けると送信確認を出し、送る で API を呼ぶ", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: makeMe(["identity:read", "identity:admin", "audit:read", "event:read"]) });
    const post = vi.spyOn(client, "post");
    renderWithProviders(<UserListPage />, { client });
    await user.click(await screen.findByTestId("fe7-users-member-link-user_carol"));
    const linkDialog = await screen.findByTestId("fe7-member-link-dialog");
    await user.click(within(linkDialog).getByTestId("fe7-member-link-option-member_hanako"));
    await user.click(within(linkDialog).getByTestId("fe7-member-link-confirm"));

    const dialog = await screen.findByTestId("fe7-account-mail-dialog");
    expect(screen.queryByTestId("fe7-member-link-dialog")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("fe7-account-mail-dialog-to")).toHaveTextContent("hanako.yamada@gmail.com");
    expect(within(dialog).getByTestId("fe7-account-mail-dialog-cc")).toHaveTextContent("carol@developershub.jp");
    await user.click(within(dialog).getByTestId("fe7-account-mail-dialog-send"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/admin/users/user_carol/account-mail", {}));
    await waitFor(() => expect(screen.queryByTestId("fe7-account-mail-dialog")).not.toBeInTheDocument());
    expect(useToastStore.getState().toasts.some((t) => t.title === "hanako.yamada@gmail.com にアカウント発行メールを送りました")).toBe(true);
  });

  it("Gmail の無い運営メンバーと紐付けても送信確認は出ない", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserListPage />);
    await user.click(await screen.findByTestId("fe7-users-member-link-user_carol"));
    const linkDialog = await screen.findByTestId("fe7-member-link-dialog");
    await user.click(within(linkDialog).getByTestId("fe7-member-link-option-member_ichiro"));
    await user.click(within(linkDialog).getByTestId("fe7-member-link-confirm"));
    const carolCell = await screen.findByTestId("fe7-users-member-user_carol");
    await waitFor(() => expect(within(carolCell).getByText("鈴木 一郎")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-account-mail-dialog")).not.toBeInTheDocument();
  });
});
