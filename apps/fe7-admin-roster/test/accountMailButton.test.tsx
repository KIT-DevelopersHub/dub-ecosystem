// @vitest-environment jsdom
// メール名簿の右ペイン「アカウント発行メールを送る」: 揃っていればボタンから送れる /
// 足りなければ disabled + 何が足りないかを表示 / 初期パスワード発行の直後にも送信確認を出す。
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { UserInlineEditor } from "../src/components/UserInlineEditor";
import { createMockClient } from "../src/api/mockClient";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const now = new Date().toISOString();
const base = { orgId: "org_devhub", avatarUrl: null, status: "active" as const, createdAt: now, updatedAt: now };
// user_bob は seed で 佐藤 太郎(Gmail あり)に紐付け済み。user_alice は未紐付け。
const bob: identity.IdentityUser = { ...base, id: "user_bob", displayName: "Bob Member", email: "bob@developershub.jp", githubLogin: "bob", roleIds: [] };
const alice: identity.IdentityUser = { ...base, id: "user_alice", displayName: "Alice Admin", email: "alice@developershub.jp", githubLogin: "alice", roleIds: [] };

const ADMIN = ["identity:read", "identity:admin"] as identity.PermissionKey[];

describe("アカウント発行メールを送る ボタン", () => {
  it("Gmail・紐付け・@developershub.jp が揃っていれば押せて、送る で API を呼ぶ", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: makeMe(ADMIN) });
    const post = vi.spyOn(client, "post");
    renderWithProviders(<UserInlineEditor user={bob} currentUserId="user_alice" />, { client });

    const open = await screen.findByTestId("fe7-user-account-mail-open");
    expect(open).toBeEnabled();
    expect(screen.queryByTestId("fe7-user-account-mail-missing")).not.toBeInTheDocument();
    await user.click(open);

    const dialog = await screen.findByTestId("fe7-account-mail-dialog");
    expect(within(dialog).getByTestId("fe7-account-mail-dialog-to")).toHaveTextContent("taro.sato@gmail.com");
    expect(within(dialog).getByTestId("fe7-account-mail-dialog-cc")).toHaveTextContent("bob@developershub.jp");
    await user.click(within(dialog).getByTestId("fe7-account-mail-dialog-send"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/admin/users/user_bob/account-mail", {}));
    await waitFor(() => expect(screen.queryByTestId("fe7-account-mail-dialog")).not.toBeInTheDocument());
  });

  it("運営メンバーと紐付いていなければ disabled で、足りない情報を出す", async () => {
    renderWithProviders(<UserInlineEditor user={alice} currentUserId="user_alice" />, { me: makeMe(ADMIN) });
    const open = await screen.findByTestId("fe7-user-account-mail-open");
    expect(open).toBeDisabled();
    expect(screen.getByTestId("fe7-user-account-mail-missing")).toHaveTextContent("運営メンバーと紐付いていません");
  });

  it("ログインが @developershub.jp でなければ、その旨を出す", async () => {
    const outside = { ...bob, email: "bob@example.com" };
    renderWithProviders(<UserInlineEditor user={outside} currentUserId="user_alice" />, { me: makeMe(ADMIN) });
    expect(await screen.findByTestId("fe7-user-account-mail-open")).toBeDisabled();
    expect(screen.getByTestId("fe7-user-account-mail-missing")).toHaveTextContent("@developershub.jp のアドレスではありません");
  });

  it("初期パスワードを発行した直後にも送信確認を出す", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserInlineEditor user={bob} currentUserId="user_alice" />, { me: makeMe(ADMIN) });
    await screen.findByTestId("fe7-user-account-mail-open");
    await user.click(screen.getByTestId("fe7-user-password-generate"));
    await screen.findByTestId("fe7-user-password-issued");
    expect(await screen.findByTestId("fe7-account-mail-dialog")).toBeInTheDocument();
  });

  it("揃っていない人は、初期パスワードを発行しても送信確認を出さない", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserInlineEditor user={alice} currentUserId="user_alice" />, { me: makeMe(ADMIN) });
    await screen.findByTestId("fe7-user-account-mail-open");
    await user.click(screen.getByTestId("fe7-user-password-generate"));
    await screen.findByTestId("fe7-user-password-issued");
    expect(screen.queryByTestId("fe7-account-mail-dialog")).not.toBeInTheDocument();
  });
});
