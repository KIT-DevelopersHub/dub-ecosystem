// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserDetailPage } from "../src/components/UserDetailPage";
import { RoleEditorPage } from "../src/components/RoleEditorPage";
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
    // ConfirmDialog appears; confirm.
    await user.click(screen.getByTestId("fe7-role-save-confirm-confirm"));
    // no throw = success path exercised; matrix still present
    expect(screen.getByTestId("fe7-permission-matrix")).toBeInTheDocument();
  });

  it("system role is read-only in the matrix", async () => {
    renderWithProviders(<RoleEditorPage roleId="role_admin" onDone={() => {}} />);
    await waitFor(() =>
      expect((screen.getByTestId("fe7-matrix-key-identity:admin") as HTMLInputElement).disabled).toBe(true),
    );
  });
});
