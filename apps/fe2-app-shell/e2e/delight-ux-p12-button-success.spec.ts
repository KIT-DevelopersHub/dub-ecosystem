// Real-browser verification for P12 (DEMO transport).
// Split out of the combined P11-P14 batch spec so this feature's e2e travels
// with its own clean PR/commit.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "delight-ux-p12-button-success");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test.describe("P12 — Button loading -> success checkmark -> normal", () => {
  test("saving account settings flashes a checkmark on the button before closing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByTestId("fe2-settings-menu").click();
    await page.getByTestId("fe2-account-settings-open").click();
    const dialog = page.getByTestId("fe2-account-settings");
    await expect(dialog).toBeVisible();

    const nameInput = page.getByTestId("fe2-account-name");
    await nameInput.fill("コウタ・デライト");
    const save = page.getByTestId("fe2-account-settings-save");
    await page.screenshot({ path: shot("p12-01-before-save.png") });

    await save.click();
    // Success checkmark shows on the button itself (no toast needed to tell success).
    await expect(save).toHaveAttribute("data-success", "true");
    await page.screenshot({ path: shot("p12-02-success-flash.png") });

    // Then the dialog closes on its own shortly after.
    await expect(dialog).toBeHidden({ timeout: 3000 });
    await page.screenshot({ path: shot("p12-03-closed.png") });
  });
});
