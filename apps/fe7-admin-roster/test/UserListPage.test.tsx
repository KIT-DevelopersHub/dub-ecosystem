// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
});
