// アカウント発行メール on 運営名簿: linking a member that has a Gmail opens the send prompt
// (after the link dialog closes), 送る calls the API and toasts; no Gmail -> no prompt. The
// row action resends for linked + Gmail rows only.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { member, type identity } from "@dub/types";
import { FakeAuthProvider, editorPermissions } from "../../auth/test-support.tsx";
import type { MembersApi } from "./membersApi.tsx";
import { MembersApiProvider } from "./MembersProvider.tsx";
import { MemberRosterPage } from "./MemberRosterPage.tsx";
import type { MembersOverview, OrgMember } from "./contracts.ts";

const P0 = member.emptyPersonProfile();
const base = { orgId: "o", roleTitle: null, status: "added" as const, teamIds: [], department: null, grade: null, contact: null, note: null, version: 1, createdAt: "t", updatedAt: "t" };

const OVERVIEW: MembersOverview = {
  teams: [],
  members: [
    { ...P0, ...base, id: "m1", name: "山田太郎", gmail: "taro.yamada@gmail.com", identityUserId: null, sortOrder: 1 },
    { ...P0, ...base, id: "m2", name: "佐藤花子", gmail: null, identityUserId: null, sortOrder: 2 },
    { ...P0, ...base, id: "m3", name: "鈴木一郎", gmail: "ichiro@gmail.com", identityUserId: "u3", sortOrder: 3 },
    { ...P0, ...base, id: "m4", name: "高橋次郎", gmail: null, identityUserId: "u4", sortOrder: 4 },
  ],
};

const USERS: identity.IdentityUser[] = [
  { id: "u1", orgId: "o", displayName: "山田太郎", email: "taro@developershub.jp", githubLogin: null, avatarUrl: null, status: "active", roleIds: [], createdAt: "t", updatedAt: "t" },
  { id: "u3", orgId: "o", displayName: "鈴木一郎", email: "ichiro@developershub.jp", githubLogin: null, avatarUrl: null, status: "active", roleIds: [], createdAt: "t", updatedAt: "t" },
  { id: "u4", orgId: "o", displayName: "高橋次郎", email: "jiro@developershub.jp", githubLogin: null, avatarUrl: null, status: "active", roleIds: [], createdAt: "t", updatedAt: "t" },
  { id: "u5", orgId: "o", displayName: "bot", email: "bot@slack-import.invalid", githubLogin: null, avatarUrl: null, status: "active", roleIds: [], createdAt: "t", updatedAt: "t" },
] as identity.IdentityUser[];

function makeApi(): MembersApi & { sendAccountMail: ReturnType<typeof vi.fn> } {
  return {
    getOverview: () => Promise.resolve(OVERVIEW),
    listTeams: () => Promise.resolve({ teams: [] }),
    createTeam: vi.fn(),
    updateTeam: vi.fn(),
    deleteTeam: vi.fn(),
    createMember: vi.fn(),
    updateMember: vi.fn((id: string, patch: Partial<OrgMember>) =>
      Promise.resolve({ ...(OVERVIEW.members.find((m) => m.id === id) as OrgMember), ...patch, version: 2 }),
    ),
    deleteMember: vi.fn(),
    linkIdentity: vi.fn((id: string) => Promise.resolve(OVERVIEW.members.find((m) => m.id === id) as OrgMember)),
    listIdentityUsers: vi.fn(() => Promise.resolve({ items: USERS, nextCursor: null })),
    sendAccountMail: vi.fn((id: string) =>
      Promise.resolve({ ok: true as const, to: "taro.yamada@gmail.com", cc: `${id}@developershub.jp`, appUrl: "https://app.developershub.jp", passwordSource: "generated" as const, messageId: "msg" }),
    ),
  } as unknown as MembersApi & { sendAccountMail: ReturnType<typeof vi.fn> };
}

function wrap(ui: ReactNode, api: MembersApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FakeAuthProvider permissions={editorPermissions("members", ["identity:read", "identity:admin"])}>
        <ToastProvider>
          <MembersApiProvider value={api}>{ui}</MembersApiProvider>
        </ToastProvider>
      </FakeAuthProvider>
    </QueryClientProvider>
  );
}

async function linkTo(user: ReturnType<typeof userEvent.setup>, memberId: string, userId: string) {
  await user.click(await screen.findByTestId(`members-link-${memberId}`));
  const dialog = await screen.findByTestId("members-link-dialog");
  await user.click(await within(dialog).findByTestId(`members-link-option-${userId}`));
  await user.click(within(dialog).getByTestId("members-link-confirm"));
}

describe("運営名簿 — アカウント発行メール", () => {
  it("紐付け成功 → 送信確認ダイアログ → 送る で API を呼び toast を出す", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(wrap(<MemberRosterPage />, api));
    await linkTo(user, "m1", "u1");

    const dialog = await screen.findByTestId("account-mail-dialog");
    // the link dialog is gone (no stacked modals)
    expect(screen.queryByTestId("members-link-dialog")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("account-mail-dialog-to")).toHaveTextContent("taro.yamada@gmail.com");
    expect(within(dialog).getByTestId("account-mail-dialog-cc")).toHaveTextContent("taro@developershub.jp");

    await user.click(within(dialog).getByTestId("account-mail-dialog-send"));
    await waitFor(() => expect(api.sendAccountMail).toHaveBeenCalledWith("u1"));
    expect(await screen.findByText("taro.yamada@gmail.com にアカウント発行メールを送りました")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("account-mail-dialog")).not.toBeInTheDocument());
  });

  it("Gmail が無いメンバーを紐付けてもダイアログは出ない", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(wrap(<MemberRosterPage />, api));
    await linkTo(user, "m2", "u1");
    await waitFor(() => expect(api.linkIdentity).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("members-link-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("account-mail-dialog")).not.toBeInTheDocument();
  });

  it("行アクションは紐付け済み + Gmail ありの行だけに出て、押すとダイアログを開く", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(wrap(<MemberRosterPage />, api));
    await screen.findByTestId("members-account-mail-m3");
    expect(screen.queryByTestId("members-account-mail-m1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("members-account-mail-m2")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("members-account-mail-m3"));
    const dialog = await screen.findByTestId("account-mail-dialog");
    expect(within(dialog).getByTestId("account-mail-dialog-cc")).toHaveTextContent("ichiro@developershub.jp");
  });

  it("紐付け済みの人に Gmail を後から登録して保存すると送信確認を出す", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(wrap(<MemberRosterPage />, api));
    await user.click(await screen.findByTestId("members-edit-m4"));
    const form = await screen.findByTestId("members-form-dialog");
    await user.type(within(form).getByTestId("members-form-gmail"), "jiro.takahashi@gmail.com");
    await user.click(within(form).getByTestId("members-form-submit"));
    const dialog = await screen.findByTestId("account-mail-dialog");
    expect(within(dialog).getByTestId("account-mail-dialog-to")).toHaveTextContent("jiro.takahashi@gmail.com");
    expect(within(dialog).getByTestId("account-mail-dialog-cc")).toHaveTextContent("jiro@developershub.jp");
  });

  it("もともと Gmail がある人を編集して保存しても送信確認は出ない", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(wrap(<MemberRosterPage />, api));
    await user.click(await screen.findByTestId("members-edit-m3"));
    const form = await screen.findByTestId("members-form-dialog");
    await user.click(within(form).getByTestId("members-form-submit"));
    await waitFor(() => expect(api.updateMember).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("members-form-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("account-mail-dialog")).not.toBeInTheDocument();
  });

  it("@developershub.jp ではないアカウントに紐付けても送信確認は出ない", async () => {
    const api = makeApi();
    const user = userEvent.setup();
    render(wrap(<MemberRosterPage />, api));
    await linkTo(user, "m1", "u5");
    await waitFor(() => expect(api.linkIdentity).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("members-link-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("account-mail-dialog")).not.toBeInTheDocument();
  });
});
