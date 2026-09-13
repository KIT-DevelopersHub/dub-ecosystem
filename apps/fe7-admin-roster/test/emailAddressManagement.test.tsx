// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailAddressManagementPage } from "../src/components/EmailAddressManagementPage";
import { renderWithProviders, makeMe } from "./renderWithProviders";

describe("EmailAddressManagementPage (@developershub.jp issued addresses)", () => {
  it("lists seeded addresses and issues a new one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmailAddressManagementPage />, { me: makeMe(["mail:admin"]) });
    await waitFor(() => expect(screen.getByText("info@developershub.jp")).toBeInTheDocument());

    await user.click(screen.getByTestId("fe7-email-new"));
    await user.type(screen.getByTestId("fe7-email-localpart"), "events");
    await user.click(screen.getByTestId("fe7-email-submit"));

    await waitFor(() => expect(screen.getByText("events@developershub.jp")).toBeInTheDocument());
  });

  it("toggles an address between 有効 and 無効", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmailAddressManagementPage />, { me: makeMe(["mail:admin"]) });
    // info is seeded enabled -> its status badge shows 有効, action offers 無効にする
    await waitFor(() => expect(within(screen.getByTestId("fe7-email-status-eml_1")).getByText("有効")).toBeInTheDocument());
    await user.click(screen.getByTestId("fe7-email-toggle-eml_1"));
    await waitFor(() => expect(within(screen.getByTestId("fe7-email-status-eml_1")).getByText("無効")).toBeInTheDocument());
  });

  it("deletes an address after confirmation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EmailAddressManagementPage />, { me: makeMe(["mail:admin"]) });
    await waitFor(() => expect(screen.getByText("noreply@developershub.jp")).toBeInTheDocument());
    await user.click(screen.getByTestId("fe7-email-delete-eml_3"));
    const confirm = await screen.findByTestId("fe7-email-delete-confirm");
    await user.click(within(confirm).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByText("noreply@developershub.jp")).not.toBeInTheDocument());
  });

  it("hides management controls from viewers without mail:admin", async () => {
    renderWithProviders(<EmailAddressManagementPage />, { me: makeMe(["identity:read"]) });
    await waitFor(() => expect(screen.getByTestId("fe7-email-header")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-email-new")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-email-toggle-eml_1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe7-email-delete-eml_1")).not.toBeInTheDocument();
  });
});
