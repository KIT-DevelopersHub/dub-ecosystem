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

  // A full 3×2 grid (matches the CSS `repeat(3, …)`; jsdom uses the 3-column fallback).
  //   row0:  a(0)  b(1)  c(2)
  //   row1:  d(3)  e(4)  f(5)
  const GRID: AppLauncherItem[] = [
    { id: "/a", label: "AA", icon: "inbox", href: "/a" },
    { id: "/b", label: "BB", icon: "inbox", href: "/b" },
    { id: "/c", label: "CC", icon: "inbox", href: "/c" },
    { id: "/d", label: "DD", icon: "inbox", href: "/d" },
    { id: "/e", label: "EE", icon: "inbox", href: "/e" },
    { id: "/f", label: "FF", icon: "inbox", href: "/f" },
  ];

  it("first arrow press anchors on the first enabled tile", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={GRID} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    await userEvent.keyboard("{ArrowDown}{Enter}"); // first press → a, not a row-step
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/a" }));
  });

  it("ArrowRight / ArrowLeft step to the horizontal neighbour", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={GRID} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    // anchor a → right → b → right → c → left → b
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowLeft}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/b" }));
  });

  it("ArrowDown / ArrowUp move a full row within the same column", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={GRID} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    // anchor a → right → b(col1) → down → e(col1, row1) → up → b
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowDown}{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/b" }));
  });

  it("ArrowDown from the top row lands on the tile directly below (not the right neighbour)", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={GRID} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    // anchor a(col0,row0) → down → d(col0,row1), NOT b (the old 1-D "next" bug)
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/d" }));
  });

  it("ArrowUp from the top row wraps to the bottom of the same column", async () => {
    const onSelect = vi.fn();
    render(<AppLauncher items={GRID} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    // anchor a(col0,row0) → up wraps → d(col0, bottom row)
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/d" }));
  });

  it("skips disabled tiles when moving down a column and never selects them", async () => {
    // col0 = a(0) enabled, d(3) DISABLED, g(6) enabled → ArrowDown from a jumps to g.
    const DIS: AppLauncherItem[] = [
      { id: "/a", label: "AA", icon: "inbox", href: "/a" },
      { id: "/b", label: "BB", icon: "inbox", href: "/b" },
      { id: "/c", label: "CC", icon: "inbox", href: "/c" },
      { id: "/d", label: "DD", icon: "settings", disabled: true, disabledReason: "準備中" },
      { id: "/e", label: "EE", icon: "inbox", href: "/e" },
      { id: "/f", label: "FF", icon: "inbox", href: "/f" },
      { id: "/g", label: "GG", icon: "inbox", href: "/g" },
      { id: "/h", label: "HH", icon: "inbox", href: "/h" },
      { id: "/i", label: "II", icon: "inbox", href: "/i" },
    ];
    const onSelect = vi.fn();
    render(<AppLauncher items={DIS} onSelect={onSelect} testId="launcher" />);
    await userEvent.click(screen.getByTestId("launcher-trigger"));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}"); // a → (skip d) → g
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "/g" }));
    expect(onSelect).not.toHaveBeenCalledWith(expect.objectContaining({ id: "/d" }));
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
