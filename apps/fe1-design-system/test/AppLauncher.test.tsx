import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppLauncher } from "../src/components/AppLauncher";
import type { AppLauncherItem } from "../src/types";

const ITEMS: AppLauncherItem[] = [
  { id: "/events", label: "イベント", icon: "calendar", href: "/events" },
  { id: "/chat", label: "チャット", icon: "chat", href: "/chat", badgeCount: 3 },
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
});
