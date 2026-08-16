// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("renders each permission domain's keys in a 2-column grid", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_organizer")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    const grid = await screen.findByTestId("fe7-role-role_organizer-matrix-grid-event");
    expect(grid).toBeInTheDocument();
    expect(grid.style.display).toBe("grid");
    // multi-column track template (auto-fit → 2 columns on a normal-width panel)
    expect(grid.style.gridTemplateColumns).toContain("repeat");
  });

  it("editor reseeds per tab: switching from admin to organizer then saving edits ONLY organizer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoleListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-row-role_admin")).toBeInTheDocument());

    // View admin first (5 perms), then switch to organizer (2 perms) via the tabs.
    await user.click(screen.getByTestId("fe7-roles-open-role_admin"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_admin")).toBeInTheDocument());
    await user.click(screen.getByTestId("fe7-roles-open-role_organizer"));
    await waitFor(() => expect(screen.getByTestId("fe7-role-inline-role_organizer")).toBeInTheDocument());

    // The organizer editor must be seeded from organizer (2), NOT leak admin's 5 keys.
    const toggle = screen.getByTestId("fe7-role-role_organizer-matrix-key-task:read") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);
    await user.click(screen.getByTestId("fe7-role-role_organizer-save"));
    const confirm = await screen.findByTestId("fe7-role-role_organizer-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));

    // organizer -> 3 (2 + task:read), and admin stays 5 (untouched by the leak).
    const orgTab = screen.getByTestId("fe7-roles-row-role_organizer");
    await waitFor(() => expect(within(orgTab).getByText("3 権限")).toBeInTheDocument());
    expect(within(screen.getByTestId("fe7-roles-row-role_admin")).getByText("5 権限")).toBeInTheDocument();
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
