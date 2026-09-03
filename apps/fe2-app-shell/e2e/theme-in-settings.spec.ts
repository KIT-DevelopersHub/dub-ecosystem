// Real-browser proof that theme switching lives behind 設定(⚙) → カラー設定 → dialog and
// still works: open 設定 → カラー設定 opens the カラー設定 dialog → pick ダーク → data-theme
// flips to "dark" (全アプリ波及 via the theme root), stays dark after reload (localStorage
// 永続), and stays dark after navigating to another app. Runs against the backend-free
// DEMO transport (VITE_DEMO=1, auto-login + seed).
import { test, expect } from "@playwright/test";

const root = "[data-dub-theme-root]";

test("theme lives in 設定 → カラー設定 dialog; dark applies app-wide and survives reload/nav", async ({ page }) => {
  await page.goto("/");

  // No standalone header theme toggle, and no bare theme rows in the ⚙ menu.
  await expect(page.getByTestId("fe2-theme-toggle-trigger")).toHaveCount(0);
  await expect(page.getByTestId("fe2-theme-option-dark")).toHaveCount(0);
  await expect(page.getByTestId("fe2-color-settings-open")).toHaveCount(0);

  // Open 設定 → a single カラー設定 entry; the raw theme options are still hidden.
  await page.getByTestId("fe2-settings-menu-trigger").click();
  await expect(page.getByTestId("fe2-color-settings-open")).toBeVisible();
  await expect(page.getByTestId("fe2-theme-option-dark")).toHaveCount(0);

  // カラー設定 opens the dialog; the theme segmented control (system/light/dark) is inside.
  await page.getByTestId("fe2-color-settings-open").click();
  await expect(page.getByTestId("fe2-color-settings")).toBeVisible();
  await expect(page.getByTestId("fe2-theme-option-system")).toBeVisible();
  await expect(page.getByTestId("fe2-theme-option-light")).toBeVisible();
  await expect(page.getByTestId("fe2-theme-option-dark")).toBeVisible();

  // Pick ダーク → the theme root flips to data-theme="dark" (recolours every app) — live.
  await page.getByTestId("fe2-theme-option-dark").click();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("fe2-theme-option-dark")).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("dub.ui.theme")))
    .toBe("dark");
  // Let the segmented pill finish gliding to the new row before the deliverable shot.
  await page.waitForTimeout(400);
  await page.screenshot({ path: "e2e/.output/color-dialog-dark.png" });

  // Close the dialog; the dark theme stays applied.
  await page.getByTestId("fe2-color-settings-close").click();
  await expect(page.getByTestId("fe2-color-settings")).toHaveCount(0);
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");

  // Persists across a full reload.
  await page.reload();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");

  // Persists when navigating into another app (全アプリ波及). The app launcher exposes
  // every tool; open it and jump to the first enabled non-home tile.
  await page.getByTestId("fe2-app-launcher-trigger").click();
  const firstTile = page.locator('[data-testid^="fe2-app-launcher-item-"]:not([disabled])').first();
  await firstTile.click();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");

  // And flipping back to ライト from the dialog recolours immediately.
  await page.getByTestId("fe2-settings-menu-trigger").click();
  await page.getByTestId("fe2-color-settings-open").click();
  await page.getByTestId("fe2-theme-option-light").click();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "light");
});
