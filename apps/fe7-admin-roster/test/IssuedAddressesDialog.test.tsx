// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssuedAddressesDialog } from "../src/components/IssuedAddressesDialog";
import { createMockClient } from "../src/api/mockClient";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const adminMe = makeMe(["identity:read", "identity:admin", "mail:admin"]);

describe("IssuedAddressesDialog", () => {
  it("lists the issued @developershub.jp addresses with a delete button per row", async () => {
    renderWithProviders(<IssuedAddressesDialog open onClose={() => {}} />, { me: adminMe });
    await waitFor(() => expect(screen.getByText("info@developershub.jp")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-issued-address-delete-eml_1")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-issued-address-delete-eml_2")).toBeInTheDocument();
  });

  it("confirms before deleting, then optimistically hides the row and offers undo", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IssuedAddressesDialog open onClose={() => {}} />, { me: adminMe });
    await waitFor(() => expect(screen.getByText("info@developershub.jp")).toBeInTheDocument());

    // Delete asks for confirmation first (誤削除防止).
    await user.click(screen.getByTestId("fe7-issued-address-delete-eml_1"));
    expect(screen.getByTestId("fe7-issued-address-delete-confirm")).toBeInTheDocument();

    // Confirm → row disappears immediately (optimistic) and an undo bar appears.
    await user.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByTestId("fe7-issued-address-row-eml_1")).not.toBeInTheDocument());
    expect(screen.getByTestId("fe7-issued-address-undo")).toBeInTheDocument();

    // Undo restores the row (no delete committed).
    await user.click(screen.getByTestId("fe7-issued-address-undo-button"));
    await waitFor(() => expect(screen.getByTestId("fe7-issued-address-row-eml_1")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-issued-address-undo")).not.toBeInTheDocument();
  });

  it("commits the deferred DELETE against the API (closing flushes a pending removal)", async () => {
    const user = userEvent.setup();
    const client = createMockClient({ me: adminMe });
    const delSpy = vi.spyOn(client, "delete");
    let closed = false;
    renderWithProviders(<IssuedAddressesDialog open onClose={() => { closed = true; }} />, { me: adminMe, client });
    await waitFor(() => expect(screen.getByText("support@developershub.jp")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-issued-address-delete-eml_2"));
    await user.click(screen.getByRole("button", { name: "削除する" }));
    expect(screen.getByTestId("fe7-issued-address-undo")).toBeInTheDocument();
    expect(delSpy).not.toHaveBeenCalled(); // deferred: not yet committed

    // Closing the dialog flushes the pending removal → the DELETE actually fires.
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await waitFor(() =>
      expect(delSpy).toHaveBeenCalledWith(expect.stringContaining("/admin/email-routing/issued-addresses/eml_2")),
    );
    expect(closed).toBe(true);
  });
});
