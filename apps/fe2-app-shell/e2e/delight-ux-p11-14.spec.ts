// Real-browser verification for the P11–P14 delight-UX batch (DEMO transport).
// One spec per behavior; screenshots land in ~/DubVault/docs/delight-ux-p11-14/.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "delight-ux-p11-14");
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

test.describe("P13 — chat send button pulse + pending message slide-in", () => {
  test("sending a message pulses the send button and slides the pending bubble in", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/chat");
    await page.getByTestId("fe6-channel-list-item").first().click();
    await expect(page.getByTestId("fe6-channel-timeline")).toBeVisible();

    const input = page.getByTestId("fe6-composer-input");
    await input.fill("delight ux p13 check");
    const send = page.getByTestId("fe6-composer-send");
    await page.screenshot({ path: shot("p13-01-before-send.png") });

    await send.click();
    // The pulse + the just-sent row are both up in the same instant — the row
    // gets the slide-in class regardless of whether the demo transport settles
    // it as "pending" or (offline demo, no backend) immediately "failed".
    await expect(send).toHaveAttribute("data-sent", "true");
    const sentRow = page.getByTestId("fe6-timeline-pending");
    await expect(sentRow).toBeVisible();
    await expect(sentRow).toHaveClass(/justSent/);
    await page.screenshot({ path: shot("p13-02-sent-pulse.png") });

    await expect(send).not.toHaveAttribute("data-sent", { timeout: 2000 });
  });
});

test.describe("P14 — app-switch crossfade", () => {
  test("in-app tab nav keeps the crossfade wrapper; switching apps remounts + fades it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/members");
    const fade = page.getByTestId("fe2-app-fade");
    await expect(fade).toBeVisible();
    await page.evaluate(() => {
      (document.querySelector('[data-testid="fe2-app-fade"]') as HTMLElement).dataset.probe = "same-app";
    });
    await page.screenshot({ path: shot("p14-01-members-tab.png") });

    // In-app SPA sub-navigation (運営メンバー -> 運営名簿, same "members" app segment) must
    // NOT remount the crossfade wrapper — the stamped marker survives.
    await page.getByTestId("member-roster-subnav").getByRole("tab", { name: "運営名簿" }).click();
    await expect(page.getByTestId("member-roster-app")).toBeVisible();
    const probeAfterTab = await page.evaluate(
      () => (document.querySelector('[data-testid="fe2-app-fade"]') as HTMLElement)?.dataset.probe,
    );
    expect(probeAfterTab).toBe("same-app");
    await page.screenshot({ path: shot("p14-02-same-app-subnav.png") });

    // Switching to a DIFFERENT app via the launcher DOES remount it (fresh div, fade replays).
    await page.getByTestId("fe2-app-launcher").click();
    const chatTile = page.getByTestId("fe2-app-launcher").locator("..").getByText("チャット", { exact: false }).first();
    await chatTile.click();
    await expect(page.getByTestId("fe6-channel-list")).toBeVisible();
    const probeAfterSwitch = await page.evaluate(
      () => (document.querySelector('[data-testid="fe2-app-fade"]') as HTMLElement)?.dataset.probe,
    );
    expect(probeAfterSwitch).toBeUndefined(); // fresh element — the stamped one is gone
    await page.screenshot({ path: shot("p14-03-after-app-switch.png") });
  });
});
