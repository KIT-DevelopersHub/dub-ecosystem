// @vitest-environment jsdom
// 「このメンバーとして表示」(代理表示): identity:impersonate を持つ人にだけ出る /
// 対象外 (自分・利用停止・管理者・代理表示中) は disabled + 理由 / 確認ダイアログ → 開始 → 画面を入れ替える。
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { ImpersonateUserSection } from "../src/components/ImpersonateUserSection";
import { UserInlineEditor } from "../src/components/UserInlineEditor";
import { createMockClient } from "../src/api/mockClient";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const now = new Date().toISOString();
const base = { orgId: "org_devhub", avatarUrl: null, createdAt: now, updatedAt: now, githubLogin: null };
const bob: identity.IdentityUser = { ...base, id: "user_bob", displayName: "Bob Member", email: "bob@developershub.jp", status: "active", roleIds: ["role_member"] };
const alice: identity.IdentityUser = { ...base, id: "user_alice", displayName: "Alice Admin", email: "alice@developershub.jp", status: "active", roleIds: ["role_admin"] };

const IMPERSONATOR = ["identity:read", "identity:admin", "identity:impersonate"] as identity.PermissionKey[];

describe("ImpersonateUserSection", () => {
  it("is hidden without identity:impersonate (identity:admin alone is not enough)", async () => {
    renderWithProviders(<UserInlineEditor user={bob} currentUserId="user_alice" />, { me: makeMe(["identity:read", "identity:admin"]) });
    await screen.findByTestId("fe7-user-inline-user_bob");
    expect(screen.queryByTestId("fe7-user-impersonate")).not.toBeInTheDocument();
  });

  it("is shown in the roster pane for an impersonator, enabled for an eligible member", async () => {
    renderWithProviders(<UserInlineEditor user={bob} currentUserId="user_alice" />, { me: makeMe(IMPERSONATOR) });
    const open = await screen.findByTestId("fe7-user-impersonate-open");
    await waitFor(() => expect(open).toBeEnabled());
    expect(screen.queryByTestId("fe7-user-impersonate-reason")).not.toBeInTheDocument();
  });

  it("disabled with a reason for yourself", async () => {
    renderWithProviders(<ImpersonateUserSection user={alice} />, { me: makeMe(IMPERSONATOR) });
    expect(await screen.findByTestId("fe7-user-impersonate-open")).toBeDisabled();
    expect(screen.getByTestId("fe7-user-impersonate-reason")).toHaveTextContent("自分自身は選べません");
  });

  it("disabled with a reason for a disabled member", async () => {
    renderWithProviders(<ImpersonateUserSection user={{ ...bob, status: "disabled" }} />, { me: makeMe(IMPERSONATOR) });
    expect(await screen.findByTestId("fe7-user-impersonate-open")).toBeDisabled();
    expect(screen.getByTestId("fe7-user-impersonate-reason")).toHaveTextContent("利用中ではないメンバー");
  });

  it("disabled with a reason for a member who holds the impersonate permission", async () => {
    const client = createMockClient({ me: makeMe(IMPERSONATOR) });
    // grant bob the key through his detail read
    const get = client.get.bind(client);
    vi.spyOn(client, "get").mockImplementation(async (path: string, q?: Record<string, unknown>) => {
      const res = (await get(path, q)) as Record<string, unknown>;
      if (path.endsWith("/identity/users/user_bob")) return { ...res, permissions: ["identity:read", "identity:impersonate"] } as never;
      return res as never;
    });
    renderWithProviders(<ImpersonateUserSection user={bob} />, { client, me: makeMe(IMPERSONATOR) });
    await waitFor(() => expect(screen.getByTestId("fe7-user-impersonate-reason")).toHaveTextContent("管理者"));
    expect(screen.getByTestId("fe7-user-impersonate-open")).toBeDisabled();
  });

  it("disabled while already impersonating (no nesting)", async () => {
    const me = { ...makeMe(IMPERSONATOR), impersonation: { actor: { id: "user_x", displayName: "X", avatarUrl: null }, startedAt: 0, expiresAt: Date.now() + 1e6 } };
    renderWithProviders(<ImpersonateUserSection user={bob} />, { me });
    expect(await screen.findByTestId("fe7-user-impersonate-open")).toBeDisabled();
    expect(screen.getByTestId("fe7-user-impersonate-reason")).toHaveTextContent("代理表示中");
  });

  it("confirm → POST /admin/users/:id/impersonation → enters the member view", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: makeMe(IMPERSONATOR) });
    const post = vi.spyOn(client, "post");
    const onEntered = vi.fn();
    renderWithProviders(<ImpersonateUserSection user={bob} onEntered={onEntered} />, { client, me: makeMe(IMPERSONATOR) });
    const open = await screen.findByTestId("fe7-user-impersonate-open");
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const dialog = await screen.findByTestId("fe7-user-impersonate-confirm");
    expect(dialog).toHaveTextContent("Bob Memberさんとして表示しますか");
    expect(dialog).toHaveTextContent("メール送信はできません");
    await user.click(within(dialog).getByRole("button", { name: "表示する" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/admin/users/user_bob/impersonation", {}));
    await waitFor(() => expect(onEntered).toHaveBeenCalledTimes(1));
  });

  it("cancel does nothing", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: makeMe(IMPERSONATOR) });
    const post = vi.spyOn(client, "post");
    renderWithProviders(<ImpersonateUserSection user={bob} />, { client, me: makeMe(IMPERSONATOR) });
    const open = await screen.findByTestId("fe7-user-impersonate-open");
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const dialog = await screen.findByTestId("fe7-user-impersonate-confirm");
    await user.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(post).not.toHaveBeenCalled();
  });
});
