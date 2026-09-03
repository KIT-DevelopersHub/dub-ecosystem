// ThemeToggle — verifies the header theme control surfaces UiStore.setTheme
// (previously persisted but unreachable) and reflects the active choice.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach } from "vitest";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { useUiStore } from "../store/uiStore.tsx";

describe("ThemeToggle", () => {
  beforeEach(() => useUiStore.setState({ theme: "system" }));

  it("opens a three-way picker (system / light / dark)", async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByTestId("fe2-theme-toggle-trigger"));
    expect(screen.getByTestId("fe2-theme-option-system")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-theme-option-light")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-theme-option-dark")).toBeInTheDocument();
  });

  it("calls setTheme('dark') and persists the choice to the store", async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByTestId("fe2-theme-toggle-trigger"));
    await userEvent.click(screen.getByTestId("fe2-theme-option-dark"));
    expect(useUiStore.getState().theme).toBe("dark");
  });

  it("marks the active choice as 使用中", async () => {
    useUiStore.setState({ theme: "light" });
    render(<ThemeToggle />);
    await userEvent.click(screen.getByTestId("fe2-theme-toggle-trigger"));
    expect(screen.getByTestId("fe2-theme-option-light")).toHaveTextContent("使用中");
    expect(screen.getByTestId("fe2-theme-option-dark")).not.toHaveTextContent("使用中");
  });
});
