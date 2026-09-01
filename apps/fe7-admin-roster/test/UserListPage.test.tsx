// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserListPage } from "../src/components/UserListPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";

describe("UserListPage", () => {
  it("renders seeded users with testids and shows invite for admin", async () => {
    renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-users-row-user_alice")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-users-invite")).toBeInTheDocument();
  });

  it("hides the invite button for read-only users", async () => {
    renderWithProviders(<UserListPage />, { me: makeMe(["identity:read"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-users-invite")).not.toBeInTheDocument();
  });

  it("does not crash when the user lacks any permission (empty me)", async () => {
    renderWithProviders(<UserListPage />, { me: makeMe([]) });
    await waitFor(() => expect(screen.getByTestId("fe7-users-header")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-users-invite")).not.toBeInTheDocument();
  });

  it("shows a placeholder pane until a user is selected", async () => {
    renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-user-pane-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("fe7-user-pane")).not.toBeInTheDocument();
  });

  it("opens the inline management pane in-page (no navigation) when a name is clicked", async () => {
    const user = userEvent.setup();
    const { navigate } = renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-users-open-user_bob")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-users-open-user_bob"));

    // The pane appears on the SAME screen with the full management surface...
    const pane = await screen.findByTestId("fe7-user-pane");
    expect(within(pane).getByText("Bob Member")).toBeInTheDocument();
    expect(within(pane).getByTestId("fe7-user-displayName")).toBeInTheDocument();
    expect(within(pane).getByTestId("fe7-user-save")).toBeInTheDocument();
    expect(within(pane).getByTestId("fe7-user-status-toggle")).toBeInTheDocument();
    expect(within(pane).getByTestId("fe7-user-assign-open")).toBeInTheDocument();
    // ...and the roster table is still mounted (never left the screen).
    expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows a ロール column with each user's org-wide roles as chips", async () => {
    renderWithProviders(<UserListPage />);
    // Alice = admin, Bob = member (seeded roleIds), Carol = none.
    await waitFor(() => expect(screen.getByTestId("fe7-role-chip-user_alice-role_admin")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-role-chip-user_alice-role_admin")).toHaveTextContent("admin");
    expect(screen.getByTestId("fe7-role-chip-user_bob-role_member")).toHaveTextContent("member");
    expect(screen.getByTestId("fe7-roles-empty-user_carol")).toBeInTheDocument();
  });

  it("admin grants a role inline from the list (optimistic) without leaving the page", async () => {
    const user = userEvent.setup();
    const { navigate } = renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-roles-empty-user_carol")).toBeInTheDocument());

    // Click Carol's roles cell (the chips ARE the trigger — no separate 編集 button)
    // and toggle "member" on.
    const cell = screen.getByTestId("fe7-user-roles-user_carol");
    await user.click(within(cell).getByRole("button", { name: "ロールを編集" }));
    await user.click(await screen.findByTestId("fe7-inline-role-toggle-user_carol-role_member"));

    // Chip appears immediately (optimistic) and no navigation happened.
    await waitFor(() => expect(screen.getByTestId("fe7-role-chip-user_carol-role_member")).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument();
  });

  it("admin revokes a role inline from the list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-role-chip-user_bob-role_member")).toBeInTheDocument());

    const cell = screen.getByTestId("fe7-user-roles-user_bob");
    await user.click(within(cell).getByRole("button", { name: "ロールを編集" }));
    // Wait until the lazily-loaded assignment enables the checkbox, then uncheck.
    const toggle = await screen.findByTestId("fe7-inline-role-toggle-user_bob-role_member");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await user.click(toggle);

    await waitFor(() => expect(screen.queryByTestId("fe7-role-chip-user_bob-role_member")).not.toBeInTheDocument());
  });

  it("shows a count summary of the loaded roster", async () => {
    renderWithProviders(<UserListPage />);
    // mock seed = 3 users (alice/bob/carol); pristine view shows the total.
    await waitFor(() => expect(screen.getByTestId("fe7-users-count")).toHaveTextContent("全 3件"));
  });

  it("reveals the bulk action bar when rows are selected, and clears it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-users-row-user_alice")).toBeInTheDocument());

    // No bar until something is checked.
    expect(screen.queryByTestId("fe7-users-bulk")).not.toBeInTheDocument();

    // Check one row (each row exposes a "行を選択" checkbox from DataTable selection).
    const rowChecks = screen.getAllByLabelText("行を選択");
    await user.click(rowChecks[0]!);

    const bar = await screen.findByTestId("fe7-users-bulk");
    expect(within(bar).getByTestId("fe7-users-bulk-count")).toHaveTextContent("1件を選択中");
    expect(within(bar).getByTestId("fe7-users-bulk-disable")).toBeInTheDocument();
    expect(within(bar).getByTestId("fe7-users-bulk-role-apply")).toBeInTheDocument();

    // No layout shift: the bar floats out of document flow (fixed overlay) rather than
    // being inserted above the table, so selecting a row never pushes the rows down.
    expect(getComputedStyle(bar).position).toBe("fixed");

    // Clearing hides the bar again.
    await user.click(within(bar).getByTestId("fe7-users-bulk-clear"));
    await waitFor(() => expect(screen.queryByTestId("fe7-users-bulk")).not.toBeInTheDocument());
  });

  it("does not offer selection or the bulk bar for read-only users", async () => {
    renderWithProviders(<UserListPage />, { me: makeMe(["identity:read"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-users-table")).toBeInTheDocument());
    // Selection column is gated on identity:admin, so no row checkboxes exist.
    expect(screen.queryByLabelText("行を選択")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-users-bulk")).not.toBeInTheDocument();
  });

  it("bulk-disables the selected users via confirm", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-users-row-user_alice")).toBeInTheDocument());

    // Select all rows via the header "全選択" checkbox, then bulk-disable.
    await user.click(screen.getByLabelText("全選択"));
    const bar = await screen.findByTestId("fe7-users-bulk");
    await user.click(within(bar).getByTestId("fe7-users-bulk-disable"));

    // Confirm dialog -> confirm.
    await user.click(await screen.findByRole("button", { name: "利用停止する" }));

    // After the bulk patch settles the roster reloads; the previously-active users
    // now render the 停止 status badge.
    await waitFor(() => expect(screen.getAllByText("停止").length).toBeGreaterThan(0));
  });

  it("hides inline role editing for read-only users (chips stay visible)", async () => {
    renderWithProviders(<UserListPage />, { me: makeMe(["identity:read"]) });
    // Chips still render for everyone...
    await waitFor(() => expect(screen.getByTestId("fe7-role-chip-user_alice-role_admin")).toBeInTheDocument());
    // ...but the cell is not an edit trigger for a read-only viewer.
    const cell = screen.getByTestId("fe7-user-roles-user_alice");
    expect(within(cell).queryByRole("button", { name: "ロールを編集" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-inline-role-edit-user_alice")).not.toBeInTheDocument();
  });

  it("offers 在籍に戻す for a non-active user, and the pane closes on ×", async () => {
    const user = userEvent.setup();
    // user_carol is seeded with status "invited" -> the status toggle offers reactivation.
    renderWithProviders(<UserListPage />);
    await waitFor(() => expect(screen.getByTestId("fe7-users-open-user_carol")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-users-open-user_carol"));
    const pane = await screen.findByTestId("fe7-user-pane");
    expect(within(pane).getByTestId("fe7-user-status-toggle")).toHaveTextContent("在籍に戻す");

    await user.click(within(pane).getByTestId("fe7-user-pane-close"));
    await waitFor(() => expect(screen.queryByTestId("fe7-user-pane")).not.toBeInTheDocument());
    expect(screen.getByTestId("fe7-user-pane-empty")).toBeInTheDocument();
  });
});
