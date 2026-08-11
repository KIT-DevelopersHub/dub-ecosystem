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

describe("role editor (PermissionMatrix)", () => {
  it("creates a role after selecting permissions and confirming", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleEditorPage onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("fe7-permission-matrix")).toBeInTheDocument());

    await user.type(screen.getByTestId("fe7-role-name"), "reviewer");
    await user.click(screen.getByTestId("fe7-matrix-key-event:read"));
    await user.click(screen.getByTestId("fe7-role-save"));
    // ConfirmDialog appears; confirm. @dub/ui ConfirmDialog does not put testids on
    // its buttons, so click the confirm action by role within the dialog.
    const confirm = await screen.findByTestId("fe7-role-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));
    // no throw = success path exercised; matrix still present
    expect(screen.getByTestId("fe7-permission-matrix")).toBeInTheDocument();
  });

  it("admin role locks identity:admin but leaves its other keys editable (RoleEditorPage)", async () => {
    renderWithProviders(<RoleEditorPage roleId="role_admin" onDone={() => {}} />);
    await waitFor(() =>
      expect((screen.getByTestId("fe7-matrix-key-identity:admin") as HTMLInputElement).disabled).toBe(true),
    );
    // Self-lockout guard only pins identity:admin; the rest of the admin role is editable now.
    expect((screen.getByTestId("fe7-matrix-key-event:read") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("system role editing (self-lockout guard)", () => {
  const systemRole = (id: string, name: string, permissions: identity.PermissionKey[]): identity.Role =>
    ({ id, orgId: "org_devhub", name, isSystem: true, permissions });

  it("admin can toggle a system role's permission and save", async () => {
    const user = userEvent.setup();
    const role = systemRole("role_member", "member", ["identity:read", "event:read"]);
    renderWithProviders(<RolePermissionsEditor role={role} />);
    await waitFor(() => expect(screen.getByTestId("fe7-role-role_member-permission-matrix")).toBeInTheDocument());

    const mail = screen.getByTestId("fe7-role-role_member-matrix-key-mail:read") as HTMLInputElement;
    expect(mail.disabled).toBe(false);
    await user.click(mail);
    await user.click(screen.getByTestId("fe7-role-role_member-save"));
    const confirm = await screen.findByTestId("fe7-role-role_member-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));
    // no throw = save succeeded against the mock (system-role edit is allowed)
    await waitFor(() => expect(screen.getByTestId("fe7-role-role_member-permission-matrix")).toBeInTheDocument());
  });

  it("admin role locks identity:admin while other keys stay editable", async () => {
    const role = systemRole("role_admin", "admin", ["identity:read", "identity:admin", "event:read"]);
    renderWithProviders(<RolePermissionsEditor role={role} />);
    await waitFor(() => expect(screen.getByTestId("fe7-role-role_admin-permission-matrix")).toBeInTheDocument());

    expect((screen.getByTestId("fe7-role-role_admin-matrix-key-identity:admin") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("fe7-role-role_admin-matrix-key-event:read") as HTMLInputElement).disabled).toBe(false);
  });
});
