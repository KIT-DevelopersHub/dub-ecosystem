import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppLauncher } from "../src/components/AppLauncher";
import type { AppLauncherItem } from "../src/types";

const ITEMS: AppLauncherItem[] = [
  { id: "/events", label: "イベント", icon: "calendar", href: "/events" },
  { id: "/chat", label: "チャット", icon: "chat", href: "/chat", badgeCount: 3 },
];

// Broader set exercising the filter + keyboard paths.
const MANY: AppLauncherItem[] = [
  { id: "/mail", label: "メール", icon: "inbox", href: "/mail" },
  { id: "/chat", label: "チャット", icon: "chat", href: "/chat" },
  { id: "/events", label: "イベント", icon: "calendar", href: "/events" },
  { id: "/soon", label: "準備中アプリ", icon: "settings", disabled: true, disabledReason: "準備中" },
];

describe("AppLauncher (waffle app switcher 凍結案 1-4-3)", () => {
  it("is closed initially and opens on the waffle trigger", async () => {
    render(<AppLauncher items={ITEMS} testId="launcher" />);
    expect(screen.queryByText("イベント")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("イベント")).toBeInTheDocument();
    expect(screen.getByText("チャット")).toBeInTheDocument();
  });

  it("renders a badge from badgeCount", async () => {
    render(<AppLauncher items={ITEMS} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("calls onSelect with the item and closes", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={ITEMS} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    await userEvent.click(screen.getByText("イベント"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/events", href: "/events" }));
    expect(screen.queryByText("イベント")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<AppLauncher items={ITEMS} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses the filter box on open", async () => {
    render(<AppLauncher items={MANY} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    expect(screen.getByTestId("launcher-search")).toHaveFocus();
  });

  it("narrows tiles by substring but keeps the catalog intact when cleared", async () => {
    render(<AppLauncher items={MANY} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    const search = screen.getByTestId("launcher-search");

    await userEvent.type(search, "チャ");
    expect(screen.getByText("チャット")).toBeInTheDocument();
    expect(screen.queryByText("メール")).not.toBeInTheDocument();
    expect(screen.queryByText("イベント")).not.toBeInTheDocument();

    // Clearing the box restores every app (nothing was removed — 消さない).
    await userEvent.clear(search);
    expect(screen.getByText("メール")).toBeInTheDocument();
    expect(screen.getByText("イベント")).toBeInTheDocument();
    expect(screen.getByText("チャット")).toBeInTheDocument();
    expect(screen.getByText("準備中アプリ")).toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", async () => {
    render(<AppLauncher items={MANY} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    await userEvent.type(screen.getByTestId("launcher-search"), "zzzzz");
    expect(screen.getByText(/一致するアプリはありません/)).toBeInTheDocument();
  });

  it("moves the active tile with ArrowDown and launches it with Enter", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={MANY} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    const search = screen.getByTestId("launcher-search");

    // First ArrowDown selects the first enabled tile (メール), second moves to チャット.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/chat" }));
    expect(search).toBeDefined();
  });

  it("skips disabled tiles during keyboard navigation and never selects them", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={MANY} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));

    // 3 enabled tiles then a disabled one; four ArrowDowns wrap back to メール, never 準備中.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/mail" }));
    expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ id: "/soon" }));
  });

  it("does not launch on the IME confirm Enter (isComposing)", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={MANY} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    const search = screen.getByTestId("launcher-search") as HTMLInputElement;

    // Pick a tile, then fire an Enter keydown flagged as an IME conversion-commit.
    await userEvent.keyboard("{ArrowDown}");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
