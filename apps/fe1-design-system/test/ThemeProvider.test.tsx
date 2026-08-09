import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider } from "../src/components/ThemeProvider";

describe("ThemeProvider", () => {
  it("sets data-theme to the controlled value and syncs on change", () => {
    const { container, rerender } = render(
      <ThemeProvider theme="light">
        <span>content</span>
      </ThemeProvider>,
    );
    const root = container.querySelector("[data-dub-theme-root]") as HTMLElement;
    expect(root).toHaveAttribute("data-theme", "light");
    const lightBrand = root.style.getPropertyValue("--dub-color-brand-500");
    expect(lightBrand).not.toBe("");

    rerender(
      <ThemeProvider theme="dark">
        <span>content</span>
      </ThemeProvider>,
    );
    expect(root).toHaveAttribute("data-theme", "dark");
    const darkBrand = root.style.getPropertyValue("--dub-color-brand-500");
    expect(darkBrand).not.toBe("");
  });

  it("never writes to localStorage (persistence is FE2's job)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <ThemeProvider theme="dark">
        <span>x</span>
      </ThemeProvider>,
    );
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
