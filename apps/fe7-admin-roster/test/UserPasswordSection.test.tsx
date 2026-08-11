// @vitest-environment jsdom
// Admin password management surface inside the roster inline pane (#5a/#5c). Covers:
// visibility gating (admin only), the issue/one-time-reveal flow, and the confirm-gated
// view flow — the three导線 the UI must offer.
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { identity } from "@dub/types";
import { UserInlineEditor } from "../src/components/UserInlineEditor";
import { renderWithProviders, makeMe } from "./renderWithProviders";

const alice: identity.IdentityUser = {
  id: "user_alice",
  orgId: "org_devhub",
  displayName: "Alice Admin",
  email: "alice@developershub.jp",
  githubLogin: "alice",
  avatarUrl: null,
  status: "active",
  roleIds: ["role_admin"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderEditor(perms: identity.PermissionKey[] = ["identity:read", "identity:admin"]) {
  return renderWithProviders(<UserInlineEditor user={alice} currentUserId="user_alice" />, { me: makeMe(perms) });
}

describe("UserPasswordSection", () => {
  it("is hidden for non-admin (read-only) viewers", async () => {
    renderEditor(["identity:read"]);
    await waitFor(() => expect(screen.getByText("メール: alice@developershub.jp")).toBeInTheDocument());
    expect(screen.queryByTestId("fe7-user-password-user_alice")).not.toBeInTheDocument();
  });

  it("shows the issue/view controls for admins", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByTestId("fe7-user-password-user_alice")).toBeInTheDocument());
    expect(screen.getByTestId("fe7-user-password-generate")).toBeInTheDocument();
    expect(screen.getByTestId("fe7-user-password-view")).toBeInTheDocument();
  });

  it("issues an initial password and reveals it ONCE with a copy affordance", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByTestId("fe7-user-password-generate");

    await user.click(screen.getByTestId("fe7-user-password-generate"));

    const issued = await screen.findByTestId("fe7-user-password-issued");
    // a non-empty password is shown in the code element
    const code = issued.querySelector("code");
    expect(code?.textContent?.length ?? 0).toBeGreaterThanOrEqual(8);
    // copy affordance is wired (userEvent installs its own clipboard; just ensure no throw)
    await user.click(within(issued).getByTestId("fe7-user-password-issued-copy"));
    // dismiss removes it (cannot be re-shown)
    await user.click(within(issued).getByTestId("fe7-user-password-issued-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("fe7-user-password-issued")).not.toBeInTheDocument());
  });

  it("views the current password only after confirming", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByTestId("fe7-user-password-view");

    await user.click(screen.getByTestId("fe7-user-password-view"));
    // confirm dialog gate
    const confirm = await screen.findByTestId("fe7-user-password-view-confirm");
    await user.click(within(confirm).getByText("表示する"));

    const revealed = await screen.findByTestId("fe7-user-password-revealed");
    expect(within(revealed).getByText("Alice-Init-0001")).toBeInTheDocument();
    // hide clears it
    await user.click(within(revealed).getByTestId("fe7-user-password-hide"));
    await waitFor(() => expect(screen.queryByTestId("fe7-user-password-revealed")).not.toBeInTheDocument());
  });
});
