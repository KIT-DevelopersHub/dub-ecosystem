// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { UserDetailPage } from "../src/components/UserDetailPage";
import { RoleEditorPage } from "../src/components/RoleEditorPage";
import { RolePermissionsEditor } from "../src/components/RolePermissionsEditor";
import { renderWithProviders, makeMe } from "./renderWithProviders";

describe("role assignment flow (UserDetailPage)", () => {
  it("grants a role and shows it in the assignment list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDetailPage userId="user_carol" currentUserId="user_alice" />);
    await waitFor(() => expect(screen.getByTestId("fe7-user-header")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-user-assign-open"));
    await user.selectOptions(screen.getByTestId("fe7-assign-role"), "role_member");
    await user.click(screen.getByTestId("fe7-assign-submit"));

    await waitFor(() => expect(screen.getByTestId("fe7-assignments-table")).toBeInTheDocument());
    expect(within(screen.getByTestId("fe7-assignments-table")).getByText("member")).toBeInTheDocument();
  });

  it("read-only user sees no assign / revoke controls", async () => {
    renderWithProviders(<UserDetailPage userId="user_bob" currentUserId="user_bob" />, { me: makeMe(["identity:read"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-user-header")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-user-assign-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-user-save")).not.toBeInTheDocument();
  });
});

describe("role editor (app policy table)", () => {
  it("creates a role after setting an app's level and confirming", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleEditorPage onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("fe7-app-access-table")).toBeInTheDocument());

    await user.type(screen.getByTestId("fe7-role-name"), "reviewer");
    // 一覧表でイベントを「閲覧」にする (旧: フラットな権限トグル)
    await user.click(screen.getByTestId("fe7-app-level-events-view"));
    expect(screen.getByTestId("fe7-app-state-events").textContent).toBe("閲覧");
    await user.click(screen.getByTestId("fe7-role-save"));
    // ConfirmDialog appears; confirm. @dub/ui ConfirmDialog does not put testids on
    // its buttons, so click the confirm action by role within the dialog.
    const confirm = await screen.findByTestId("fe7-role-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));
    // no throw = success path exercised; the table is still present
    expect(screen.getByTestId("fe7-app-access-table")).toBeInTheDocument();
  });

  it("admin role pins the 管理 app (both tiers) but leaves other apps editable", async () => {
    renderWithProviders(<RoleEditorPage roleId="role_admin" onDone={() => {}} />);
    // 管理 is frozen (self-lockout guard) — its level cannot be lowered. The lock resolves
    // once useRoles() has loaded the role, so wait on the disabled state itself.
    await waitFor(() =>
      expect((screen.getByTestId("fe7-app-level-admin-none") as HTMLButtonElement).disabled).toBe(true),
    );
    // ...while every other app stays switchable.
    expect((screen.getByTestId("fe7-app-level-events-none") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("system role editing (self-lockout guard)", () => {
  const systemRole = (id: string, name: string, permissions: identity.PermissionKey[]): identity.Role =>
    ({ id, orgId: "org_devhub", name, isSystem: true, permissions });

  it("admin can change a system role's app level and save", async () => {
    const user = userEvent.setup();
    const role = systemRole("role_member", "member", ["identity:read", "event:read", "app:events:view"]);
    renderWithProviders(<RolePermissionsEditor role={role} />);
    const ns = "fe7-role-role_member";
    await waitFor(() => expect(screen.getByTestId(`${ns}-app-access-table`)).toBeInTheDocument());

    await user.click(screen.getByTestId(`${ns}-app-level-events-edit`));
    expect(screen.getByTestId(`${ns}-app-state-events`).textContent).toBe("編集");
    await user.click(screen.getByTestId(`${ns}-save`));
    const confirm = await screen.findByTestId(`${ns}-save-confirm`);
    await user.click(within(confirm).getByRole("button", { name: "確認" }));
    // no throw = save succeeded against the mock (system-role edit is allowed)
    await waitFor(() => expect(screen.getByTestId(`${ns}-app-access-table`)).toBeInTheDocument());
  });

  it("admin role locks the 管理 app level and identity:admin (運営メンバー配下)", async () => {
    const user = userEvent.setup();
    const role = systemRole("role_admin", "admin", ["identity:read", "identity:admin", "app:admin:view", "app:admin:edit"]);
    renderWithProviders(<RolePermissionsEditor role={role} />);
    const ns = "fe7-role-role_admin";
    await waitFor(() => expect(screen.getByTestId(`${ns}-app-access-table`)).toBeInTheDocument());

    // 管理アプリ自体の段階が固定（無効に落とせない = 自分の首を切らせない）。
    await user.click(screen.getByTestId(`${ns}-app-name-admin`));
    const adminDialog = await screen.findByTestId(`${ns}-app-dialog`);
    expect((within(adminDialog).getByTestId(`${ns}-app-dialog-level-none`) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(adminDialog).getByTestId(`${ns}-app-dialog-close`));

    // identity:admin は 運営メンバー アプリ配下の細かい権限。アプリを有効にしても固定のまま。
    await user.click(screen.getByTestId(`${ns}-app-level-members-view`));
    await user.click(screen.getByTestId(`${ns}-app-name-members`));
    const membersDialog = await screen.findByTestId(`${ns}-app-dialog`);
    expect((within(membersDialog).getByTestId(`${ns}-app-dialog-toggle-identity:admin`) as HTMLInputElement).disabled).toBe(true);
    expect((within(membersDialog).getByTestId(`${ns}-app-dialog-toggle-identity:read`) as HTMLInputElement).disabled).toBe(false);
  });
});
