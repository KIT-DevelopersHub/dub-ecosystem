// Real-browser proof that theme switching moved INTO the 設定(⚙) menu and still works:
// open 設定 → pick ダーク → data-theme flips to "dark" (全アプリ波及 via the theme root),
// stays dark after reload (localStorage 永続), and stays dark after navigating to another
// app. Runs against the backend-free DEMO transport (VITE_DEMO=1, auto-login + seed).
import { test, expect } from "@playwright/test";

const root = "[data-dub-theme-root]";

test("theme switch lives in 設定 menu; dark applies app-wide and survives reload/nav", async ({ page }) => {
  await page.goto("/");

  // No standalone header theme toggle any more.
  await expect(page.getByTestId("fe2-theme-toggle-trigger")).toHaveCount(0);

  // Options are hidden until the 設定 menu opens.
  await expect(page.getByTestId("fe2-theme-option-dark")).toHaveCount(0);
  await page.getByTestId("fe2-settings-menu-trigger").click();
  await expect(page.getByTestId("fe2-theme-option-system")).toBeVisible();
  await expect(page.getByTestId("fe2-theme-option-light")).toBeVisible();
  await expect(page.getByTestId("fe2-theme-option-dark")).toBeVisible();

  // Pick ダーク → the theme root flips to data-theme="dark" (recolours every app).
  await page.getByTestId("fe2-theme-option-dark").click();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("dub.ui.theme")))
    .toBe("dark");
  await page.screenshot({ path: "e2e/.output/theme-dark.png" });

  // Persists across a full reload.
  await page.reload();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");

  // Persists when navigating into another app (全アプリ波及). The app launcher exposes
  // every tool; open it and jump to the first enabled non-home tile.
  await page.getByTestId("fe2-app-launcher-trigger").click();
  const firstTile = page.locator('[data-testid^="fe2-app-launcher-item-"]:not([disabled])').first();
  await firstTile.click();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");

  // And flipping back to ライト recolours immediately.
  await page.getByTestId("fe2-settings-menu-trigger").click();
  await page.getByTestId("fe2-theme-option-light").click();
  await expect(page.locator(root)).toHaveAttribute("data-theme", "light");
});
