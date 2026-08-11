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
