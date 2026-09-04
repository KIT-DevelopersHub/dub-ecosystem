import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.tsx";

function makeCommands(over: Partial<Record<string, () => void>> = {}): PaletteCommand[] {
  return [
    { id: "app:/mail", label: "メール", group: "アプリ", icon: "inbox", keywords: ["mail"], run: over.mail ?? vi.fn() },
    { id: "app:/events", label: "イベント", group: "アプリ", icon: "calendar", keywords: ["events"], run: over.events ?? vi.fn() },
    {
      id: "app:/admin",
      label: "ロール管理",
      group: "アプリ",
      icon: "shield",
      keywords: ["admin"],
      disabled: true,
      disabledReason: "権限がありません（アクセス不可）",
      run: over.admin ?? vi.fn(),
    },
    { id: "action:logout", label: "ログアウト", group: "アクション", icon: "log-out", keywords: ["logout"], run: over.logout ?? vi.fn() },
  ];
}

async function openPalette(): Promise<void> {
  // Global Cmd/Ctrl+K toggle.
  await userEvent.keyboard("{Control>}k{/Control}");
}

describe("CommandPalette", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is hidden until Cmd/Ctrl+K, then shows the search input", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    expect(screen.queryByTestId("fe2-cmdk")).not.toBeInTheDocument();
    await openPalette();
    expect(await screen.findByTestId("fe2-cmdk")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-cmdk-input")).toHaveFocus();
  });

  it("toggles closed on a second Cmd/Ctrl+K", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    expect(await screen.findByTestId("fe2-cmdk")).toBeInTheDocument();
    await openPalette();
    expect(screen.queryByTestId("fe2-cmdk")).not.toBeInTheDocument();
  });

  it("filters commands incrementally by label and keyword", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    const input = await screen.findByTestId("fe2-cmdk-input");
    // Type an ASCII keyword — only the mail app matches.
    await userEvent.type(input, "mail");
    expect(screen.getByTestId("fe2-cmdk-item-app-mail")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-cmdk-item-app-events")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-cmdk-item-action-logout")).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    await userEvent.type(await screen.findByTestId("fe2-cmdk-input"), "zzzzz");
    expect(screen.getByTestId("fe2-cmdk-empty")).toBeInTheDocument();
  });

  it("runs the active command on Enter and closes (↓ moves selection)", async () => {
    const events = vi.fn();
    render(<CommandPalette commands={makeCommands({ events })} />);
    await openPalette();
    const input = await screen.findByTestId("fe2-cmdk-input");
    // First option (メール) is active by default; ↓ moves to イベント.
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(events).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("fe2-cmdk")).not.toBeInTheDocument();
  });

  it("runs a command on click", async () => {
    const mail = vi.fn();
    render(<CommandPalette commands={makeCommands({ mail })} />);
    await openPalette();
    await userEvent.click(await screen.findByTestId("fe2-cmdk-item-app-mail"));
    expect(mail).toHaveBeenCalledTimes(1);
  });

  it("does not run a disabled (gated) command and keeps it visible", async () => {
    const admin = vi.fn();
    render(<CommandPalette commands={makeCommands({ admin })} />);
    await openPalette();
    const item = await screen.findByTestId("fe2-cmdk-item-app-admin");
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(admin).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe2-cmdk")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    expect(await screen.findByTestId("fe2-cmdk")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("fe2-cmdk")).not.toBeInTheDocument();
  });

  it("closes when the overlay backdrop is clicked", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    await userEvent.click(await screen.findByTestId("fe2-cmdk-overlay"));
    expect(screen.queryByTestId("fe2-cmdk")).not.toBeInTheDocument();
  });

  it("surfaces recently-run commands in a 最近使った項目 section on reopen", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    await userEvent.click(await screen.findByTestId("fe2-cmdk-item-app-events"));
    // Reopen — events should now appear under the recents section, first.
    await openPalette();
    expect(await screen.findByText("最近使った項目")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("data-testid", "fe2-cmdk-item-app-events");
  });

  it("exposes combobox/listbox a11y wiring with aria-activedescendant", async () => {
    render(<CommandPalette commands={makeCommands()} />);
    await openPalette();
    const input = await screen.findByTestId("fe2-cmdk-input");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const activeOption = document.getElementById(active!);
    expect(activeOption).toHaveAttribute("aria-selected", "true");
  });
});
