// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleListPage } from "../src/components/RoleListPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";

describe("RoleListPage (single-screen inline permissions)", () => {
  it("expands a role in place and shows its permission matrix on the SAME screen", async () => {
    const user = userEvent.setup();
    const { navigate } = renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_organizer")).toBeInTheDocument());

    // collapsed: no inline editor yet
    expect(screen.queryByTestId("fe7-role-inline-role_organizer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));

    // inline editor + full 33-key matrix appear WITHOUT any navigation
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-role_organizer-permission-matrix")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-role-role_organizer-matrix-key-event:read")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe7-roles-open-role_organizer")).toHaveAttribute("aria-expanded", "true");
  });

  it("opens one role at a time (accordion)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_admin")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_member"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_member")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-role-inline-role_organizer")).not.toBeInTheDocument();
  });

  it("edits a permission inline and saves via confirm", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_organizer")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    const toggle = await screen.findByTestId("fe7-role-role_organizer-matrix-key-task:read");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);

    // role_organizer starts with 2 permissions (event:read, event:write)
    const row = screen.getByTestId("fe7-roles-row-role_organizer");
    expect(within(row).getByText("2 権限")).toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-role-role_organizer-save"));
    const confirm = await screen.findByTestId("fe7-role-role_organizer-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));

    // save persists via the update API and the refetched list shows the new count,
    // all on the same screen (matrix stays mounted, no navigation away).
    await waitFor(() => expect(within(row).getByText("3 権限")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-role_organizer-permission-matrix")).toBeInTheDocument();
  });

  it("admin can edit a system role inline; admin role pins identity:admin", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_admin")).toBeInTheDocument());

    // admin role: identity:admin is locked (self-lockout guard) but the role is still
    // editable — the Save button is present and other keys are toggleable.
    await user.click(screen.getByTestId("fe7-roles-open-role_admin"));
    await waitFor(() =>
      expect((screen.getByTestId("fe7-role-role_admin-matrix-key-identity:admin") as HTMLInputElement).disabled).toBe(true),
    );
    expect((screen.getByTestId("fe7-role-role_admin-matrix-key-mail:admin") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId("fe7-role-role_admin-save")).toBeInTheDocument();

    // a non-admin system role (member) is fully editable, identity:admin included.
    await user.click(screen.getByTestId("fe7-roles-open-role_member"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-role_member-permission-matrix")).toBeInTheDocument());
    expect((screen.getByTestId("fe7-role-role_member-matrix-key-event:read") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId("fe7-role-role_member-save")).toBeInTheDocument();
  });

  it("read-only user can view permissions inline but cannot edit or create", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />, { me: makeMe(["identity:read"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_organizer")).toBeInTheDocument());

    expect(screen.queryByTestId("fe7-roles-new")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-roles-delete-role_organizer")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() =>
      expect((screen.getByTestId("fe7-role-role_organizer-matrix-key-event:read") as HTMLInputElement).disabled).toBe(true),
    );
    expect(screen.queryByTestId("fe7-role-role_organizer-save")).not.toBeInTheDocument();
  });
});
