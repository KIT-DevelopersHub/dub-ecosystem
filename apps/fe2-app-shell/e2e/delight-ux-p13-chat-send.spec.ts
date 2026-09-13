// Real-browser verification for P13 (DEMO transport).
// Split out of the combined P11-P14 batch spec so this feature's e2e travels
// with its own clean PR/commit.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "delight-ux-p13-chat-send");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

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
