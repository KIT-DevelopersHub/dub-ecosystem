// カラー設定ダイアログ — the theme picker moved out of the ⚙ menu into this dialog. These
// verify it shows the current theme, drives UiStore.setTheme (全アプリ波及 + localStorage
// 永続の入口) immediately on selection, and only renders when open.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColorSettingsDialog } from "./ColorSettingsDialog.tsx";
import { useUiStore } from "../store/uiStore.tsx";

describe("ColorSettingsDialog", () => {
  beforeEach(() => useUiStore.setState({ theme: "system" }));

  it("does not render its content while closed", () => {
    render(<ColorSettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("fe2-color-settings")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-color-theme-segmented")).not.toBeInTheDocument();
  });

  it("renders the theme segmented control with system/light/dark options when open", () => {
    render(<ColorSettingsDialog open onClose={() => {}} />);
    expect(screen.getByTestId("fe2-color-settings")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-theme-option-system")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-theme-option-dark")).toBeInTheDocument();
  });

  it("marks the current theme as selected and shows it in the current-setting line", () => {
    useUiStore.setState({ theme: "light" });
    render(<ColorSettingsDialog open onClose={() => {}} />);
    expect(screen.getByTestId("fe2-theme-option-light")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("fe2-theme-option-dark")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("fe2-color-theme-current")).toHaveTextContent("ライト");
  });

  it("drives UiStore.setTheme immediately on selection (live preview, no 保存 step)", async () => {
    render(<ColorSettingsDialog open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId("fe2-theme-option-dark"));
    expect(useUiStore.getState().theme).toBe("dark");
    // The current-setting line reflects the new choice.
    expect(screen.getByTestId("fe2-color-theme-current")).toHaveTextContent("ダーク");
  });

  it("closes via the 閉じる footer button", async () => {
    let closed = false;
    render(<ColorSettingsDialog open onClose={() => (closed = true)} />);
    await userEvent.click(screen.getByTestId("fe2-color-settings-close"));
    expect(closed).toBe(true);
  });
});
