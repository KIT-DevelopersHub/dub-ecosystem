// ヘッダーのメール = メンバー切り替え (代理表示の入口): 権限がある人だけドロップダウン /
// 検索で絞れる / 対象外は disabled + 理由 / 選ぶ → 確認 → 開始 → 再読込 / 代理中は「自分に戻る」。
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { gateway, identity } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { HeaderAccountSwitcher, toSwitcherItems } from "./HeaderAccountSwitcher.tsx";

const now = "2026-11-06T00:00:00Z";
const user = (id: string, displayName: string, o: Partial<identity.IdentityUser> = {}): identity.IdentityUser => ({
  id, orgId: "org", displayName, email: `${id}@developershub.jp`, githubLogin: null, avatarUrl: null,
  status: "active", roleIds: ["role_member"], createdAt: now, updatedAt: now, ...o,
});
const USERS = [
  user("usr_admin", "管理 太郎", { roleIds: ["role_admin"] }),
  user("usr_hanako", "山田 花子"),
  user("usr_jiro", "田中 次郎", { status: "disabled" }),
  user("usr_boss", "社長", { roleIds: ["role_admin"] }),
];
const ROLES: identity.Role[] = [
  { id: "role_admin", orgId: "org", name: "admin", permissions: ["identity:admin", "identity:impersonate"], isSystem: true },
  { id: "role_member", orgId: "org", name: "member", permissions: ["identity:read"], isSystem: true },
];

function meOf(permissions: identity.PermissionKey[], impersonating = false): gateway.MeResponse {
  return {
    user: { id: impersonating ? "usr_hanako" : "usr_admin", displayName: impersonating ? "山田 花子" : "管理 太郎", avatarUrl: null },
    orgId: "org",
    permissions,
    sessionExpiresAt: Date.now() + 3_600_000,
    ...(impersonating ? { impersonation: { actor: { id: "usr_admin", displayName: "管理 太郎", avatarUrl: null }, startedAt: Date.now(), expiresAt: Date.now() + 3_600_000 } } : {}),
  };
}

function setup(me: gateway.MeResponse) {
  const get = vi.fn(async (path: string) => {
    if (path === "/users") return { items: USERS, nextCursor: null };
    if (path === "/roles") return { items: ROLES, nextCursor: null };
    throw new Error(path);
  });
  const startImpersonation = vi.fn().mockResolvedValue({ impersonation: {} });
  const stopImpersonation = vi.fn().mockResolvedValue(undefined);
  const api = { auth: { me: () => Promise.resolve(me), startImpersonation, stopImpersonation }, identity: { get } } as unknown as ApiClient;
  const reload = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider api={api}>
          <HeaderAccountSwitcher api={api} email="admin@developershub.jp" reload={reload} />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { get, startImpersonation, stopImpersonation, reload };
}

describe("HeaderAccountSwitcher", () => {
  it("members without identity:impersonate see the plain email (no dropdown, no fetch)", async () => {
    const { get } = setup(meOf(["identity:read", "identity:admin"]));
    expect(await screen.findByTestId("fe2-header-account")).toHaveTextContent("admin@developershub.jp");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("fe2-header-switcher-trigger")).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("impersonators get a dropdown: skeleton, then members with name + email; search filters", async () => {
    const u = userEvent.setup();
    const { get } = setup(meOf(["identity:read", "identity:impersonate"]));
    const trigger = await screen.findByTestId("fe2-header-switcher-trigger");
    expect(get).not.toHaveBeenCalled(); // lazy: nothing loads until opened
    await u.click(trigger);
    expect(screen.getByTestId("fe2-header-switcher-search")).toHaveFocus();
    expect(await screen.findByTestId("fe2-impersonate-option-usr_hanako")).toHaveTextContent("usr_hanako@developershub.jp");
    await u.type(screen.getByTestId("fe2-header-switcher-search"), "田中");
    await waitFor(() => expect(screen.queryByTestId("fe2-impersonate-option-usr_hanako")).not.toBeInTheDocument());
    expect(screen.getByTestId("fe2-impersonate-option-usr_jiro")).toBeInTheDocument();
    await u.clear(screen.getByTestId("fe2-header-switcher-search"));
    await u.type(screen.getByTestId("fe2-header-switcher-search"), "nobody");
    expect(await screen.findByTestId("fe2-header-switcher-empty")).toBeInTheDocument();
  });

  it("ineligible members are disabled with the reason (self / inactive / admin)", async () => {
    const u = userEvent.setup();
    const { startImpersonation } = setup(meOf(["identity:read", "identity:impersonate"]));
    await u.click(await screen.findByTestId("fe2-header-switcher-trigger"));
    const self = await screen.findByTestId("fe2-impersonate-option-usr_admin");
    expect(self).toHaveAttribute("aria-disabled", "true");
    expect(self).toHaveTextContent("自分自身は選べません");
    expect(screen.getByTestId("fe2-impersonate-option-usr_jiro")).toHaveTextContent("利用中ではないメンバー");
    expect(screen.getByTestId("fe2-impersonate-option-usr_boss")).toHaveTextContent("管理者");
    await u.click(screen.getByTestId("fe2-impersonate-option-usr_boss"));
    expect(screen.queryByTestId("fe2-header-impersonate-confirm")).not.toBeInTheDocument();
    expect(startImpersonation).not.toHaveBeenCalled();
  });

  it("choose → confirm → start → reload (keyboard: arrows + Enter)", async () => {
    const u = userEvent.setup();
    const { startImpersonation, reload } = setup(meOf(["identity:read", "identity:impersonate"]));
    await u.click(await screen.findByTestId("fe2-header-switcher-trigger"));
    await screen.findByTestId("fe2-impersonate-option-usr_hanako");
    await u.type(screen.getByTestId("fe2-header-switcher-search"), "花子");
    await u.keyboard("{Enter}");
    const dialog = await screen.findByTestId("fe2-header-impersonate-confirm");
    expect(dialog).toHaveTextContent("山田 花子さんとして表示しますか");
    await u.click(within(dialog).getByRole("button", { name: "表示する" }));
    await waitFor(() => expect(startImpersonation).toHaveBeenCalledWith("usr_hanako"));
    await waitFor(() => expect(reload).toHaveBeenCalledWith("/"));
  });

  it("Escape closes the panel and returns focus to the trigger", async () => {
    const u = userEvent.setup();
    setup(meOf(["identity:read", "identity:impersonate"]));
    const trigger = await screen.findByTestId("fe2-header-switcher-trigger");
    await u.click(trigger);
    await u.keyboard("{Escape}");
    expect(screen.queryByTestId("fe2-header-switcher-search")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("while impersonating: shows the subject and offers 自分に戻る", async () => {
    const u = userEvent.setup();
    const { stopImpersonation, reload } = setup(meOf(["identity:read"], true));
    const trigger = await screen.findByTestId("fe2-header-impersonating-trigger");
    expect(trigger).toHaveTextContent("山田 花子（代理表示中）");
    await u.click(trigger);
    await u.click(screen.getByTestId("fe2-header-impersonation-return"));
    await waitFor(() => expect(stopImpersonation).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledWith("/");
  });
});

describe("toSwitcherItems", () => {
  it("active members first, then by name; eligibility from role permissions", () => {
    const items = toSwitcherItems(USERS, ROLES, "usr_admin");
    expect(items.map((i) => i.id).at(-1)).toBe("usr_jiro");
    expect(items.find((i) => i.id === "usr_hanako")?.disabledReason).toBeUndefined();
    expect(items.find((i) => i.id === "usr_boss")?.disabledReason).toMatch(/管理者/);
  });
});
