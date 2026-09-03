// themeMenu — verifies the 設定(⚙) theme rows surface UiStore.setTheme (system/light/
// dark), mark the active choice, and control the group separator. The rows moved here
// from the old standalone header ThemeToggle; behaviour is unchanged.
import { describe, it, expect, vi } from "vitest";
import { buildThemeMenuItems } from "./themeMenu.tsx";

describe("buildThemeMenuItems", () => {
  it("builds a system / light / dark group with stable ids and testIds", () => {
    const items = buildThemeMenuItems("system", vi.fn());
    expect(items.map((i) => i.id)).toEqual(["theme-system", "theme-light", "theme-dark"]);
    expect(items.map((i) => i.testId)).toEqual([
      "fe2-theme-option-system",
      "fe2-theme-option-light",
      "fe2-theme-option-dark",
    ]);
  });

  it("marks only the active choice as 使用中", () => {
    const items = buildThemeMenuItems("light", vi.fn());
    const light = items.find((i) => i.id === "theme-light");
    const dark = items.find((i) => i.id === "theme-dark");
    expect(light?.label).toContain("使用中");
    expect(dark?.label).not.toContain("使用中");
  });

  it("calls setTheme with the chosen value on select", () => {
    const setTheme = vi.fn();
    const items = buildThemeMenuItems("system", setTheme);
    items.find((i) => i.id === "theme-dark")?.onSelect();
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("adds a divider above the group by default and omits it when it is the first section", () => {
    expect(buildThemeMenuItems("system", vi.fn()).at(0)?.dividerBefore).toBe(true);
    expect(buildThemeMenuItems("system", vi.fn(), false).at(0)?.dividerBefore).toBeUndefined();
  });
});
