// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamMailingListsDialog } from "../src/components/TeamMailingListsDialog";
import { createMockClient } from "../src/api/mockClient";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const adminMe = makeMe(["identity:read", "identity:admin", "mail:admin"]);

describe("TeamMailingListsDialog", () => {
  it("shows each list with its team and how many members it reaches", async () => {
    renderWithProviders(<TeamMailingListsDialog open onClose={() => {}} />, { me: adminMe });
    await waitFor(() => expect(screen.getByText("design@developershub.jp")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("デザインチーム・受信できる人 1 / 2 人")).toBeInTheDocument());
  });

  it("prefills the address from the team, then adds the created list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TeamMailingListsDialog open onClose={() => {}} />, { me: adminMe });
    await waitFor(() => expect(screen.getByRole("option", { name: "広報チーム" })).toBeInTheDocument());
    // A team that already has a list cannot get a second one.
    expect(screen.queryByRole("option", { name: "デザインチーム" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("fe7-team-list-team"), "広報チーム");
    expect(screen.getByTestId("fe7-team-list-localpart")).toHaveValue("pr");
    await user.click(screen.getByTestId("fe7-team-list-submit"));
    await waitFor(() => expect(screen.getByText("pr@developershub.jp")).toBeInTheDocument());
  });

  it("shows a server rejection in the form and keeps the input", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TeamMailingListsDialog open onClose={() => {}} />, { me: adminMe });
    await waitFor(() => expect(screen.getByRole("option", { name: "広報チーム" })).toBeInTheDocument());
    await user.selectOptions(screen.getByTestId("fe7-team-list-team"), "広報チーム");
    await user.clear(screen.getByTestId("fe7-team-list-localpart"));
    await user.type(screen.getByTestId("fe7-team-list-localpart"), "design");
    await user.click(screen.getByTestId("fe7-team-list-submit"));
    await waitFor(() => expect(screen.getByTestId("fe7-team-list-localpart")).toHaveValue("design"));
    expect(screen.queryByText("pr@developershub.jp")).not.toBeInTheDocument();
  });

  it("confirms before deleting, hides the row at once and restores it on failure", async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    const realDelete = client.delete.bind(client);
    client.delete = vi.fn(async (path: string) => {
      if (path.includes("/mail/admin/lists/")) throw new Error("boom");
      return realDelete(path);
    }) as typeof client.delete;
    renderWithProviders(<TeamMailingListsDialog open onClose={() => {}} />, { me: adminMe, client });
    await waitFor(() => expect(screen.getByTestId("fe7-team-list-row-list_1")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-team-list-delete-list_1"));
    await user.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(client.delete).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("fe7-team-list-row-list_1")).toBeInTheDocument());
  });
});
