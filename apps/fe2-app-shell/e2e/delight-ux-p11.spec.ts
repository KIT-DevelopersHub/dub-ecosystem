// Real-browser verification for the P11 delight-UX behavior (DEMO transport).
// Split out of the original combined P11-P14 spec so this feature can ship
// (and be verified) independently of P12/P13/P14.
// Screenshots land in ~/DubVault/docs/delight-ux-p11/.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "delight-ux-p11");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test.describe("P11 — MyTaskList quick-complete checkmark + row flash", () => {
  test("checking a task draws the checkmark and flashes the row green, then fades", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/me/tasks");
    await expect(page.getByTestId("fe4-mytasks-list")).toBeVisible();

    // tsk_2 (会場レイアウト図作成) is seeded todo/ME_ID — completable.
    const box = page.getByTestId("fe4-mytask-complete-tsk_2");
    const row = page.getByTestId("fe4-mytask-row-tsk_2");
    await row.scrollIntoViewIfNeeded();
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("aria-checked", "false");
    await row.screenshot({ path: shot("p11-01-before.png") });

    await box.click();
    // Row flash + checkmark draw are both up right after the click.
    await expect(row).toHaveClass(/rowJustCompleted/);
    await expect(box).toHaveAttribute("aria-checked", "true");
    await row.screenshot({ path: shot("p11-02-checked-flash.png") });

    // The flash fades back out on its own (900ms row animation).
    await expect(row).not.toHaveClass(/rowJustCompleted/, { timeout: 3000 });
    await expect(box).toBeDisabled(); // one-way — reopen lives in the detail dialog
    await row.screenshot({ path: shot("p11-03-settled.png") });
  });
});
