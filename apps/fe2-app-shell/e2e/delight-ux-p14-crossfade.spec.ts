// Real-browser verification for P14 (app-switch crossfade) DEMO transport.
// Screenshots land in ~/DubVault/docs/delight-ux-p14-crossfade/.
// Split out from the original combined P11-P14 spec so this PR carries only P14.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "delight-ux-p14-crossfade");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

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
