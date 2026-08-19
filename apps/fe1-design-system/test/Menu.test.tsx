import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Menu } from "../src/components/Menu";
import type { MenuItem } from "../src/types";

function items(onSelect = vi.fn()): MenuItem[] {
  return [
    { id: "change-password", label: "パスワード変更", icon: "lock", onSelect, testId: "cp" },
  ];
}

describe("Menu (dropdown 設定/kebab primitive)", () => {
  it("is closed initially and opens on the trigger", async () => {
    render(<Menu label="設定" icon="settings" items={items()} testId="menu" />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("menu-trigger"));
    expect(screen.getByRole("menu", { name: "設定" })).toBeInTheDocument();
    expect(screen.getByText("パスワード変更")).toBeInTheDocument();
  });

  it("calls the item's onSelect and closes on select", async () => {
    const onSelect = vi.fn();
    render(<Menu label="設定" items={items(onSelect)} testId="menu" />);
    await userEvent.click(screen.getByTestId("menu-trigger"));
    await userEvent.click(screen.getByTestId("cp"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<Menu label="設定" items={items()} testId="menu" />);
    await userEvent.click(screen.getByTestId("menu-trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on outside click", async () => {
    render(
      <div>
        <Menu label="設定" items={items()} testId="menu" />
        <button type="button">外側</button>
      </div>,
    );
    await userEvent.click(screen.getByTestId("menu-trigger"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByText("外側"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not fire onSelect for a disabled item", async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="設定"
        testId="menu"
        items={[{ id: "x", label: "近日公開", disabled: true, onSelect, testId: "x" }]}
      />,
    );
    await userEvent.click(screen.getByTestId("menu-trigger"));
    expect(screen.getByTestId("x")).toBeDisabled();
    await userEvent.click(screen.getByTestId("x"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
