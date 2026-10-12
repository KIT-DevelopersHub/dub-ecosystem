// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { RolePolicyEditor } from "../src/components/RolePolicyEditor";
import { AppDetailDialog } from "../src/components/AppDetailDialog";
import { OrgSettingDialog } from "../src/components/OrgSettingDialog";
import { createMockClient } from "../src/api/mockClient";
import { makeMe, renderWithProviders } from "./renderWithProviders";

const DRIVE_ROLE: identity.PermissionKey[] = ["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"];
// Same as the server rule: identity:admin AND Drive共有 編集 + drive:write.
const ADMIN = makeMe(["identity:read", "identity:admin", ...DRIVE_ROLE]);

function openDriveDialog(opts: Parameters<typeof renderWithProviders>[1] = {}) {
  return renderWithProviders(
    <OrgSettingDialog settingId="google-account" onClose={() => {}} />,
    { me: ADMIN, ...opts },
  );
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

const ACCOUNT = { kind: "connected" as const, connectedBy: "user_alice", needsReconnect: false };
const MAIN = { ...ACCOUNT, id: "dga_main", email: "hackit@gmail.com", connectedAt: "2026-10-01T09:00:00.000Z", active: true };
const SUB = { ...ACCOUNT, id: "dga_sub", email: "hackit.sub@gmail.com", connectedAt: "2026-10-05T09:00:00.000Z", active: false };

describe("その他 > Google アカウント ダイアログ", () => {
  it("登録済みのアカウントを並べ、使用中・接続日時・注意書きを出す", async () => {
    openDriveDialog();
    const panel = screen.getByTestId("fe7-drive-google");
    expect(within(panel).getByTestId("fe7-drive-google-loading")).toBeInTheDocument();

    expect(await within(panel).findByTestId("fe7-drive-google-email-dga_main")).toHaveTextContent("hackit@gmail.com");
    expect(within(panel).getByTestId("fe7-drive-google-active-dga_main")).toHaveTextContent("使用中");
    expect(within(panel).getByTestId("fe7-drive-google-account-dga_main")).toHaveTextContent(/接続日時: 2026\/10\/01/);
    expect(within(panel).getByTestId("fe7-drive-google-email-dga_sub")).toHaveTextContent("hackit.sub@gmail.com");
    expect(within(panel).queryByTestId("fe7-drive-google-active-dga_sub")).not.toBeInTheDocument();
    // 使用中の行には「切り替える」「削除」を出さない
    expect(within(panel).queryByTestId("fe7-drive-google-switch-dga_main")).not.toBeInTheDocument();
    expect(within(panel).queryByTestId("fe7-drive-google-remove-dga_main")).not.toBeInTheDocument();
    expect(within(panel).getByTestId("fe7-drive-google-switch-dga_sub")).toHaveTextContent("切り替える");
    expect(within(panel).getByTestId("fe7-drive-google-add")).toHaveTextContent("アカウントを追加");
    expect(within(panel).getByTestId("fe7-drive-google-owner-note")).toHaveTextContent(
      "切り替えても既存ファイルのオーナーは移りません。",
    );
    expect(screen.getByTestId("fe7-setting-dialog")).toHaveTextContent("Google アカウント");
  });

  it("「切り替える」で使用中がすぐ移り (楽観的)、サーバーにも反映される", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: ADMIN });
    openDriveDialog({ client });
    await user.click(await screen.findByTestId("fe7-drive-google-switch-dga_sub"));
    expect(screen.getByTestId("fe7-drive-google-active-dga_sub")).toHaveTextContent("使用中");
    expect(screen.queryByTestId("fe7-drive-google-active-dga_main")).not.toBeInTheDocument();
    const server = await client.get<{ accounts: { id: string; active: boolean }[] }>("/api/v1/driveshare/google-account");
    expect(server.accounts.find((a) => a.active)?.id).toBe("dga_sub");
  });

  it("切り替えに失敗したら元の使用中に戻す", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: ADMIN });
    vi.spyOn(client, "post").mockRejectedValue({ code: "UPSTREAM_UNAVAILABLE", message: "down" });
    openDriveDialog({ client });
    await user.click(await screen.findByTestId("fe7-drive-google-switch-dga_sub"));
    await waitFor(() => expect(screen.getByTestId("fe7-drive-google-active-dga_main")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-drive-google-active-dga_sub")).not.toBeInTheDocument();
  });

  it("使っていないアカウントは確認のうえ削除できる", async () => {
    const user = userEvent.setup();
    openDriveDialog();
    await user.click(await screen.findByTestId("fe7-drive-google-remove-dga_sub"));
    expect(screen.getByTestId("fe7-drive-google-remove-confirm")).toHaveTextContent("hackit.sub@gmail.com");
    await user.click(within(screen.getByTestId("fe7-drive-google-remove-confirm")).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByTestId("fe7-drive-google-account-dga_sub")).not.toBeInTheDocument());
    expect(screen.getByTestId("fe7-drive-google-account-dga_main")).toBeInTheDocument();
  });

  it("サーバー初期設定のアカウントも並び、切り替え先に選べる (削除はできない)", async () => {
    const secret = { id: "secret", kind: "secret" as const, email: "hackit@gmail.com", connectedAt: null, connectedBy: null, active: false, needsReconnect: false };
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { accounts: [secret, { ...SUB, active: true }] } } });
    expect(await screen.findByTestId("fe7-drive-google-account-secret")).toHaveTextContent("サーバーの初期設定のアカウント");
    expect(screen.getByTestId("fe7-drive-google-switch-secret")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-drive-google-remove-secret")).not.toBeInTheDocument();
  });

  it("invalid_grant なら「再接続してください」の警告と、その行に「再接続」を出す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { accounts: [{ ...MAIN, needsReconnect: true }, SUB] } } });
    expect(await screen.findByTestId("fe7-drive-google-reconnect-warning")).toHaveTextContent("再接続してください");
    expect(screen.getByTestId("fe7-drive-google-broken-dga_main")).toHaveTextContent("要再接続");
    expect(screen.getByTestId("fe7-drive-google-reconnect-dga_main")).toHaveTextContent("再接続");
  });

  it("再接続は Google の画面でその行のアドレスを選んだ状態にする", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign, origin: "https://fe2.example" } as Location);
    const client = createMockClient({ me: ADMIN, driveGoogle: { accounts: [MAIN, { ...SUB, needsReconnect: true }] } });
    const post = vi.spyOn(client, "post");
    openDriveDialog({ client });
    await user.click(await screen.findByTestId("fe7-drive-google-reconnect-dga_sub"));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1]).toMatchObject({ loginHint: "hackit.sub@gmail.com" });
  });

  it("認証が切れたアカウントには切り替えられない", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { accounts: [MAIN, { ...SUB, needsReconnect: true }] } } });
    expect(await screen.findByTestId("fe7-drive-google-switch-dga_sub")).toBeDisabled();
  });

  it("サーバー初期設定のアカウントの認証が切れても「再接続」は出さない (画面からは直せない)", async () => {
    const secret = { id: "secret", kind: "secret" as const, email: null, connectedAt: null, connectedBy: null, active: true, needsReconnect: true };
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { accounts: [secret, SUB] } } });
    expect(await screen.findByTestId("fe7-drive-google-account-secret")).toHaveTextContent("サーバー設定の更新が必要です");
    expect(screen.queryByTestId("fe7-drive-google-reconnect-secret")).not.toBeInTheDocument();
  });

  it("使用中が 1 つも無ければ切り替えを促す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { accounts: [{ ...MAIN, active: false }, SUB] } } });
    expect(await screen.findByTestId("fe7-drive-google-none-active")).toHaveTextContent("切り替えてください");
  });

  it("まだ 1 つも無ければその旨と「アカウントを追加」を出す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { accounts: [] } } });
    expect(await screen.findByTestId("fe7-drive-google-empty")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-drive-google-add")).toHaveTextContent("アカウントを追加");
  });

  it("サーバー設定が無いときは追加できず、理由を出す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { canConnect: false } } });
    expect(await screen.findByTestId("fe7-drive-google-add")).toBeDisabled();
    expect(screen.getByTestId("fe7-drive-google-unconfigured")).toBeInTheDocument();
  });

  it("管理者でなければ API を呼ばず、管理者だけと案内する", async () => {
    const viewer = makeMe(["identity:read"]);
    const client = createMockClient({ me: viewer });
    const get = vi.spyOn(client, "get");
    openDriveDialog({ me: viewer, client });
    expect(screen.getByTestId("fe7-drive-google-admin-only")).toBeInTheDocument();
    expect(get.mock.calls.some(([p]) => String(p).includes("google-account"))).toBe(false);
  });

  it("Drive共有 が「閲覧」の管理者にも出さない (サーバーは 403 になるため)", () => {
    const viewOnly = makeMe(["identity:read", "identity:admin", "app:driveshare:view", "drive:read"]);
    openDriveDialog({ me: viewOnly, seed: { me: viewOnly } });
    expect(screen.getByTestId("fe7-drive-google-admin-only")).toBeInTheDocument();
  });

  it("アカウントを追加 → Google の URL へ移動する (戻り先は /admin/roles)", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign, origin: "https://fe2.example" } as Location);
    openDriveDialog();
    await user.click(await screen.findByTestId("fe7-drive-google-add"));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign.mock.calls[0]![0]).toMatch(/^https:\/\/fe2\.example\/admin\/roles\?code=mock-code&state=mock_state_1$/);
    expect(window.sessionStorage.getItem("fe7:oauth-return-setting")).toBe("google-account");
  });

  it("Google から戻ると その他 > Google アカウント のダイアログが開き、追加したアカウントが使用中になり URL から code を消す", async () => {
    const client = createMockClient({ me: ADMIN });
    // issue a state the mock will accept, as the connect step would have
    const { authUrl } = await client.post<{ authUrl: string }>("/api/v1/driveshare/google-account/connect", {
      redirectUri: "http://localhost/admin/roles",
    });
    window.history.replaceState(null, "", `/admin/roles${new URL(authUrl).search}`);
    window.sessionStorage.setItem("fe7:oauth-return-setting", "google-account");

    renderWithProviders(<RolePolicyEditor selected={DRIVE_ROLE} onChange={() => {}} />, { me: ADMIN, client });
    const dialog = screen.getByTestId("fe7-setting-dialog");
    expect(screen.queryByTestId("fe7-app-dialog")).not.toBeInTheDocument();
    expect(await within(dialog).findByText("hackit.new@gmail.com")).toBeInTheDocument();
    const added = within(dialog).getByText("hackit.new@gmail.com").closest("li")!;
    expect(within(added).getByText("使用中")).toBeInTheDocument();
    expect(within(dialog).getByText("hackit@gmail.com")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("同意画面でキャンセルして戻ったら、追加されていないことを伝える", async () => {
    window.history.replaceState(null, "", "/admin/roles?error=access_denied&state=x");
    renderWithProviders(<RolePolicyEditor selected={DRIVE_ROLE} onChange={() => {}} />, { me: ADMIN });
    expect(await screen.findByTestId("fe7-drive-google-return-error")).toHaveTextContent("キャンセル");
    expect(await screen.findByTestId("fe7-drive-google-email-dga_main")).toHaveTextContent("hackit@gmail.com");
  });

  it("Drive共有 の詳細ダイアログには出さない (その他 に置く)", () => {
    renderWithProviders(
      <AppDetailDialog appId="driveshare" selected={DRIVE_ROLE} onChange={() => {}} onClose={() => {}} />,
      { me: ADMIN },
    );
    expect(screen.queryByTestId("fe7-drive-google")).not.toBeInTheDocument();
  });
});

describe("Google アカウント設定の入口", () => {
  it("その他 の表に「Google アカウント」の行があり、クリックでダイアログが開く", async () => {
    renderWithProviders(<RolePolicyEditor selected={DRIVE_ROLE} onChange={() => {}} />, { me: ADMIN });
    const other = screen.getByTestId("fe7-other-permissions");
    expect(within(other).getByTestId("fe7-other-name-google-account")).toHaveTextContent("Google アカウント");
    expect(screen.queryByTestId("fe7-setting-dialog")).not.toBeInTheDocument();
    await userEvent.click(within(other).getByTestId("fe7-other-detail-google-account"));
    expect(await screen.findByTestId("fe7-drive-google-email-dga_main")).toHaveTextContent("hackit@gmail.com");
  });

  it("直リンク ?setting=google-account でダイアログが開き、閉じると URL から消える", async () => {
    window.history.replaceState(null, "", "/admin/roles?setting=google-account");
    renderWithProviders(<RolePolicyEditor selected={DRIVE_ROLE} onChange={() => {}} />, { me: ADMIN });
    expect(await screen.findByTestId("fe7-drive-google-email-dga_main")).toHaveTextContent("hackit@gmail.com");
    await userEvent.click(screen.getByTestId("fe7-setting-dialog-close"));
    expect(screen.queryByTestId("fe7-setting-dialog")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
