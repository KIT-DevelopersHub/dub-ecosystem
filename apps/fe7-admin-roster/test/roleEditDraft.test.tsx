// @vitest-environment jsdom
// Draft autosave + restore regression for the role editor (P1-2).
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleEditorPage } from "../src/components/RoleEditorPage";
import { renderWithProviders } from "./renderWithProviders";

const KEY = "fe7.role.new";

describe("RoleEditorPage — draft autosave (create mode)", () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.clear();
    } catch {
      /* storage disabled */
    }
  });

  it("auto-saves the role name and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<RoleEditorPage onDone={() => {}} />);
    await user.type(screen.getByTestId("fe7-role-name"), "reviewer");
    await waitFor(() => expect(globalThis.localStorage.getItem(KEY)).toContain("reviewer"));

    unmount();
    renderWithProviders(<RoleEditorPage onDone={() => {}} />);
    expect((screen.getByTestId("fe7-role-name") as HTMLInputElement).value).toBe("reviewer");
    expect(screen.getByTestId("fe7-role-draft-notice")).toBeInTheDocument();
  });

  it("discards the restored draft from the notice", async () => {
    const user = userEvent.setup();
    globalThis.localStorage.setItem(KEY, JSON.stringify({ name: "捨てるロール", permissions: [] }));
    renderWithProviders(<RoleEditorPage onDone={() => {}} />);
    expect((screen.getByTestId("fe7-role-name") as HTMLInputElement).value).toBe("捨てるロール");
    await user.click(screen.getByTestId("fe7-role-draft-notice-discard"));
    expect((screen.getByTestId("fe7-role-name") as HTMLInputElement).value).toBe("");
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });
});
