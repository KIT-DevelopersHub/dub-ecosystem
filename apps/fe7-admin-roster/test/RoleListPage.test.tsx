// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { appRegistry } from "@dub/types";
import { RoleListPage } from "../src/components/RoleListPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";

describe("RoleListPage (single-screen inline permissions)", () => {
  it("shows a skeleton while loading (not the empty state), then the list (FRONTEND_GUIDE §5)", async () => {
    renderWithProviders(<RoleListPage />);
    // initial render is loading: skeleton is shown, empty state is NOT
    expect(screen.getByTestId("fe7-roles-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-roles-empty")).not.toBeInTheDocument();
    // once data arrives the skeleton is replaced by the real list
    await waitFor(() => expect(screen.getByTestId("fe7-roles-list")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-roles-skeleton")).not.toBeInTheDocument();
  });

  it("selects the first role by default so the screen is never empty (clarity)", async () => {
    renderWithProviders(<RoleListPage />);
    // A caption labels the strip as a selector, and the first role (admin) is
    // pre-selected with its matrix already visible — no empty "pick a role" state.
    await waitFor(() => expect(screen.getByTestId("fe7-roles-caption")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-roles-open-role_admin")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_admin")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-role_admin-app-access-table")).toBeInTheDocument();
  });

  it("clicking the already-selected tab keeps it selected (no deselect to empty)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_admin")).toBeInTheDocument());
    // admin is selected by default; clicking it again must NOT collapse to empty.
    await user.click(screen.getByTestId("fe7-roles-open-role_admin"));
    expect(screen.getByTestId("fe7-roles-open-role_admin")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("fe7-role-inline-role_admin")).toBeInTheDocument();
  });

  it("expands a role in place and shows its app policy table on the SAME screen", async () => {
    const user = userEvent.setup();
    const { navigate } = renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_organizer")).toBeInTheDocument());

    // collapsed: no inline editor yet
    expect(screen.queryByTestId("fe7-role-inline-role_organizer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));

    // inline editor + the per-app level table appear WITHOUT any navigation
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-role_organizer-app-access-table")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-role-role_organizer-app-level-events")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe7-roles-open-role_organizer")).toHaveAttribute("aria-expanded", "true");
  });

  it("opens one role at a time (accordion)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_admin")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_member"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_member")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-role-inline-role_organizer")).not.toBeInTheDocument();
  });

  it("edits a detail permission via the app dialog and saves via confirm", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_organizer")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    // 詳細は「アプリ名クリック → ダイアログ」。配下の細かい権限はアプリを有効にしてから触る。
    await user.click(await screen.findByTestId("fe7-role-role_organizer-app-name-tasks"));
    const dialog = await screen.findByTestId("fe7-role-role_organizer-app-dialog");
    await user.click(within(dialog).getByTestId("fe7-role-role_organizer-app-dialog-level-view"));
    const toggle = within(dialog).getByTestId("fe7-role-role_organizer-app-dialog-toggle-task:read");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByTestId("fe7-role-role_organizer-app-dialog-close"));

    // role_organizer starts with 2 permissions (event:read, event:write)
    const row = screen.getByTestId("fe7-roles-open-role_organizer");
    expect(within(row).getByText("2 権限")).toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-role-role_organizer-save"));
    const confirm = await screen.findByTestId("fe7-role-role_organizer-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));

    // save persists via the update API and the refetched list shows the new count
    // (2 + app:tasks:view + task:read), all on the same screen (no navigation away).
    await waitFor(() => expect(within(row).getByText("4 権限")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-role_organizer-app-access-table")).toBeInTheDocument();
  });

  it("admin can edit a system role inline; admin role pins identity:admin", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_admin")).toBeInTheDocument());

    // admin role: identity:admin is locked (self-lockout guard) but the role is still
    // editable — the Save button is present and other keys are toggleable.
    await user.click(screen.getByTestId("fe7-roles-open-role_admin"));
    await waitFor(() =>
      expect((screen.getByTestId("fe7-role-role_admin-app-level-admin-none") as HTMLButtonElement).disabled).toBe(true),
    );
    // ...every other app's level stays switchable, and Save is available.
    expect((screen.getByTestId("fe7-role-role_admin-app-level-mail-none") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("fe7-role-role_admin-save")).toBeInTheDocument();

    // a non-admin system role (member) is fully editable, 管理 app included.
    await user.click(screen.getByTestId("fe7-roles-open-role_member"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-role_member-app-access-table")).toBeInTheDocument());
    expect((screen.getByTestId("fe7-role-role_member-app-level-admin-none") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("fe7-role-role_member-save")).toBeInTheDocument();
  });

  it("switches roles via the top tab strip and shows one role's matrix at a time", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-list")).toBeInTheDocument());

    // The role strip is a tablist; each tab reflects selection via aria-selected.
    expect(screen.getByTestId("fe7-roles-list")).toHaveAttribute("role", "tablist");
    const organizerTab = screen.getByTestId("fe7-roles-open-role_organizer");
    expect(organizerTab).toHaveAttribute("role", "tab");
    expect(organizerTab).toHaveAttribute("aria-selected", "false");

    await user.click(organizerTab);
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());
    expect(organizerTab).toHaveAttribute("aria-selected", "true");
    // switching to another tab replaces the panel (only one matrix mounted at a time)
    await user.click(screen.getByTestId("fe7-roles-open-role_admin"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_admin")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-role-inline-role_organizer")).not.toBeInTheDocument();
  });

  it("lists EVERY registered app as one table row, plus the その他 area below", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_organizer")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-role_organizer-app-access-table")).toBeInTheDocument());
    // 一覧はアプリ単位の行だけ。アプリを新規登録すれば自動で 1 行増える(手動追加なし)。
    for (const appId of appRegistry.APP_IDS) {
      expect(screen.getByTestId(`fe7-role-role_organizer-app-name-${appId}`)).toBeInTheDocument();
      expect(screen.getByTestId(`fe7-role-role_organizer-app-level-${appId}`)).toBeInTheDocument();
    }
    // アプリ単位でない権限は一番下の「その他」に、分類ごと 1 行でまとまる（トグルはダイアログ側）。
    const other = screen.getByTestId("fe7-role-role_organizer-other-permissions");
    expect(within(other).getByTestId("fe7-role-role_organizer-other-name-infra")).toBeInTheDocument();
    expect(within(other).getByTestId("fe7-role-role_organizer-other-name-audit")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-role-role_organizer-other-toggle-infra:deploy")).not.toBeInTheDocument();

    await user.click(within(other).getByTestId("fe7-role-role_organizer-other-name-infra"));
    const dialog = await screen.findByTestId("fe7-role-role_organizer-other-dialog");
    expect(within(dialog).getByTestId("fe7-role-role_organizer-other-toggle-infra:deploy")).toBeInTheDocument();
  });

  // メッセージ削除ポリシーはロール管理から撤去した（ロールの権限ではなくチャット側の設定）。
  // 画面直下にもチャットのダイアログにも出さない。
  it("メッセージ削除ポリシーはロール管理のどこにも出ない", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_organizer")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-chat-deletion-policy")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await user.click(await screen.findByTestId("fe7-role-role_organizer-app-name-chat"));
    const dialog = await screen.findByTestId("fe7-role-role_organizer-app-dialog");
    expect(within(dialog).queryByTestId("fe7-chat-deletion-policy")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("fe7-role-role_organizer-app-dialog-settings")).not.toBeInTheDocument();
  });

  it("editor reseeds per tab: switching from admin to organizer then saving edits ONLY organizer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_admin")).toBeInTheDocument());

    // View admin first (7 perms), then switch to organizer (2 perms) via the tabs.
    await user.click(screen.getByTestId("fe7-roles-open-role_admin"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_admin")).toBeInTheDocument());
    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());

    // The organizer editor must be seeded from organizer (2), NOT leak admin's 5 keys.
    await user.click(screen.getByTestId("fe7-role-role_organizer-app-name-tasks"));
    const dialog = await screen.findByTestId("fe7-role-role_organizer-app-dialog");
    await user.click(within(dialog).getByTestId("fe7-role-role_organizer-app-dialog-level-view"));
    const toggle = within(dialog).getByTestId("fe7-role-role_organizer-app-dialog-toggle-task:read") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);
    await user.click(within(dialog).getByTestId("fe7-role-role_organizer-app-dialog-close"));
    await user.click(screen.getByTestId("fe7-role-role_organizer-save"));
    const confirm = await screen.findByTestId("fe7-role-role_organizer-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));

    // organizer -> 4 (2 + app:tasks:view + task:read), and admin stays 7 (untouched by the leak).
    const orgTab = screen.getByTestId("fe7-roles-open-role_organizer");
    await waitFor(() => expect(within(orgTab).getByText("4 権限")).toBeInTheDocument());
    expect(within(screen.getByTestId("fe7-roles-open-role_admin")).getByText("7 権限")).toBeInTheDocument();
  });

  // 閲覧 の管理者: identity:admin は持つが 管理アプリが「閲覧」= サーバの requireAdminEdit が 403 に
  // する状態。UI 側も同じ判定(policy.decide)で書き込み操作を一切出さない — 押せるのに 403 になる
  // ボタンを見せないための本命の回帰テスト。
  it("管理アプリが「閲覧」の管理者には作成・保存の操作を出さない (サーバの 403 と一致)", async () => {
    const user = userEvent.setup();
    const viewerAdmin = makeMe(["identity:read", "identity:admin", "app:admin:view"], { exact: true });
    renderWithProviders(<RoleListPage />, { me: viewerAdmin });
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_organizer")).toBeInTheDocument());

    expect(screen.queryByTestId("fe7-roles-new")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-roles-delete-role_organizer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() =>
      expect((screen.getByTestId("fe7-role-role_organizer-app-level-events-edit") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.queryByTestId("fe7-role-role_organizer-save")).not.toBeInTheDocument();
  });

  it("read-only user can view permissions inline but cannot edit or create", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />, { me: makeMe(["identity:read"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-roles-open-role_organizer")).toBeInTheDocument());

    expect(screen.queryByTestId("fe7-roles-new")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-roles-delete-role_organizer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    // 閲覧者は段階セレクタも詳細トグルも押せない(表示だけ)。
    await waitFor(() =>
      expect((screen.getByTestId("fe7-role-role_organizer-app-level-events-edit") as HTMLButtonElement).disabled).toBe(true),
    );
    await user.click(screen.getByTestId("fe7-role-role_organizer-other-name-audit"));
    expect((screen.getByTestId("fe7-role-role_organizer-other-toggle-audit:read") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("fe7-role-role_organizer-save")).not.toBeInTheDocument();
  });
});
