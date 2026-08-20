// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatDeletionPolicySection } from "../src/components/ChatDeletionPolicySection";
import { renderWithProviders, makeMe } from "./renderWithProviders";

// A segment button reflects selection via aria-pressed / aria-selected; assert on it.
function isSelected(el: HTMLElement): boolean {
  return el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true";
}

describe("ChatDeletionPolicySection", () => {
  it("shows the all-hard default and lets a chat:moderate holder switch a tier and save", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChatDeletionPolicySection />, {
      me: makeMe(["identity:read", "identity:admin", "chat:moderate"]),
    });

    // default policy = all hard: both tiers land on 完全に消す
    await screen.findByTestId("fe7-chatdel-member-hard");
    expect(isSelected(screen.getByTestId("fe7-chatdel-member-hard"))).toBe(true);
    expect(isSelected(screen.getByTestId("fe7-chatdel-moderator-hard"))).toBe(true);

    // save disabled until a change is made
    expect((screen.getByTestId("fe7-chatdel-save") as HTMLButtonElement).disabled).toBe(true);

    // switch 一般メンバー -> 痕跡を残す, then save + confirm
    await user.click(screen.getByTestId("fe7-chatdel-member-tombstone"));
    expect((screen.getByTestId("fe7-chatdel-save") as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId("fe7-chatdel-save"));
    const confirm = await screen.findByTestId("fe7-chatdel-save-confirm");
    await user.click(within(confirm).getByRole("button", { name: "確認" }));

    // after the save the server echoes the new policy -> not dirty -> save disabled again
    await waitFor(() => expect((screen.getByTestId("fe7-chatdel-save") as HTMLButtonElement).disabled).toBe(true));
    expect(isSelected(screen.getByTestId("fe7-chatdel-member-tombstone"))).toBe(true);
    expect(isSelected(screen.getByTestId("fe7-chatdel-moderator-hard"))).toBe(true);
  });

  it("is read-only without chat:moderate (segments disabled, no save button)", async () => {
    renderWithProviders(<ChatDeletionPolicySection />, {
      me: makeMe(["identity:read", "identity:admin"]), // no chat:moderate
    });
    await screen.findByTestId("fe7-chatdel-member-hard");
    expect((screen.getByTestId("fe7-chatdel-member-hard") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("fe7-chatdel-member-tombstone") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("fe7-chatdel-save")).toBeNull();
  });
});
