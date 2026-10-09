// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { RolePolicyEditor } from "../src/components/RolePolicyEditor";
import { AppDetailDialog } from "../src/components/AppDetailDialog";
import { createMockClient } from "../src/api/mockClient";
import { makeMe, renderWithProviders } from "./renderWithProviders";

const DRIVE_ROLE: identity.PermissionKey[] = ["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"];
// Same as the server rule: identity:admin AND Drive共有 編集 + drive:write.
const ADMIN = makeMe(["identity:read", "identity:admin", ...DRIVE_ROLE]);

function openDriveDialog(opts: Parameters<typeof renderWithProviders>[1] = {}) {
  return renderWithProviders(
    <AppDetailDialog appId="driveshare" selected={DRIVE_ROLE} onChange={() => {}} onClose={() => {}} />,
    { me: ADMIN, ...opts },
  );
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Drive共有 詳細ダイアログ > Google アカウント", () => {
  it("一番下のセクションに、接続中のアカウント・日時・注意書きを出す", async () => {
    openDriveDialog();
    const panel = screen.getByTestId("fe7-drive-google");
    expect(within(panel).getByTestId("fe7-drive-google-loading")).toBeInTheDocument();

    expect(await within(panel).findByTestId("fe7-drive-google-email")).toHaveTextContent("hackit@gmail.com");
    expect(within(panel).getByTestId("fe7-drive-google-badge")).toHaveTextContent("接続済み");
    expect(within(panel).getByTestId("fe7-drive-google-meta")).toHaveTextContent(/接続日時: 2026\/10\/01/);
    expect(within(panel).getByTestId("fe7-drive-google-connect")).toHaveTextContent("接続し直す");
    expect(within(panel).getByTestId("fe7-drive-google-owner-note")).toHaveTextContent(
      "アカウントを切り替えても既存ファイルのオーナーは移りません。",
    );
    // the last block of the dialog
    const dialog = screen.getByTestId("fe7-app-dialog");
    const sections = dialog.querySelectorAll("section, div > h3");
    expect(sections[sections.length - 1]?.closest("section")).toBe(panel);
  });

  it("invalid_grant なら「再接続してください」の警告を出す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { needsReconnect: true } } });
    expect(await screen.findByTestId("fe7-drive-google-reconnect-warning")).toHaveTextContent("再接続してください");
    expect(screen.getByTestId("fe7-drive-google-badge")).toHaveTextContent("要再接続");
  });

  it("未接続なら「Google アカウントを接続」を出す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { source: "none", email: null, connectedAt: null } } });
    expect(await screen.findByTestId("fe7-drive-google-connect")).toHaveTextContent("Google アカウントを接続");
    expect(screen.getByTestId("fe7-drive-google-email")).toHaveTextContent("なし");
  });

  it("サーバー設定が無いときは押せず、理由を出す", async () => {
    openDriveDialog({ seed: { me: ADMIN, driveGoogle: { canConnect: false } } });
    expect(await screen.findByTestId("fe7-drive-google-connect")).toBeDisabled();
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

  it("接続し直す → 確認 → Google の URL へ移動する (戻り先は /admin/roles)", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign, origin: "https://fe2.example" } as Location);
    openDriveDialog();
    await user.click(await screen.findByTestId("fe7-drive-google-connect"));
    expect(screen.getByTestId("fe7-drive-google-confirm")).toHaveTextContent("下書きとして残り");
    await user.click(screen.getByTestId("fe7-drive-google-confirm-go"));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign.mock.calls[0]![0]).toMatch(/^https:\/\/fe2\.example\/admin\/roles\?code=mock-code&state=mock_state_1$/);
    expect(window.sessionStorage.getItem("fe7:oauth-return-app")).toBe("driveshare");
  });

  it("Google から戻ると Drive共有 のダイアログが開き、接続を完了して URL から code を消す", async () => {
    const client = createMockClient({ me: ADMIN });
    // issue a state the mock will accept, as the connect step would have
    const { authUrl } = await client.post<{ authUrl: string }>("/api/v1/driveshare/google-account/connect", {
      redirectUri: "http://localhost/admin/roles",
    });
    window.history.replaceState(null, "", `/admin/roles${new URL(authUrl).search}`);
    window.sessionStorage.setItem("fe7:oauth-return-app", "driveshare");

    renderWithProviders(<RolePolicyEditor selected={DRIVE_ROLE} onChange={() => {}} />, { me: ADMIN, client });
    const dialog = screen.getByTestId("fe7-app-dialog");
    expect(dialog).toHaveTextContent("Drive");
    expect(await within(dialog).findByText("hackit.new@gmail.com")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("同意画面でキャンセルして戻ったら、切り替わっていないことを伝える", async () => {
    window.history.replaceState(null, "", "/admin/roles?error=access_denied&state=x");
    renderWithProviders(<RolePolicyEditor selected={DRIVE_ROLE} onChange={() => {}} />, { me: ADMIN });
    expect(await screen.findByTestId("fe7-drive-google-return-error")).toHaveTextContent("キャンセル");
    expect(await screen.findByTestId("fe7-drive-google-email")).toHaveTextContent("hackit@gmail.com");
  });

  it("Drive共有 以外のアプリには出ない", () => {
    renderWithProviders(
      <AppDetailDialog appId="chat" selected={["app:chat:view"]} onChange={() => {}} onClose={() => {}} />,
      { me: ADMIN },
    );
    expect(screen.queryByTestId("fe7-drive-google")).not.toBeInTheDocument();
  });
});
