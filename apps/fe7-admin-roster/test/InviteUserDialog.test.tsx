// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InviteUserDialog } from "../src/components/InviteUserDialog";
import { renderWithProviders } from "./renderWithProviders";

describe("InviteUserDialog", () => {
  it("shows a field error for an invalid email (VALIDATION_FAILED)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InviteUserDialog open onClose={() => {}} />);
    await user.type(screen.getByTestId("fe7-invite-email"), "bad-email");
    await user.click(screen.getByTestId("fe7-invite-submit"));
    await waitFor(() => expect(screen.getByText("メール形式が不正です")).toBeInTheDocument());
  });

  it("shows a conflict message for a duplicate email (CONFLICT)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InviteUserDialog open onClose={() => {}} />);
    await user.type(screen.getByTestId("fe7-invite-email"), "alice@developershub.jp");
    await user.click(screen.getByTestId("fe7-invite-submit"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("closes on a successful invite", async () => {
    const user = userEvent.setup();
    let closed = false;
    renderWithProviders(<InviteUserDialog open onClose={() => { closed = true; }} />);
    await user.type(screen.getByTestId("fe7-invite-email"), "brandnew@developershub.jp");
    await user.click(screen.getByTestId("fe7-invite-submit"));
    await waitFor(() => expect(closed).toBe(true));
  });
});
