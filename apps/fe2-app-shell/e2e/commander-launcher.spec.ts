// Commander launcher integration E2E (real browser, DEMO transport). Proves the
// phase-3 launcher wiring: the Commander app tile appears in the 9-dot AppLauncher
// for the (admin) demo user and opening it renders the /commander screen (run console
// + phase board). Admin-only + member-hidden gating is unit-tested; here we prove the
// tile is actually reachable and the route mounts in a real browser.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "commander-launcher");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const TRIGGER = "fe2-app-launcher-trigger";
const PANEL = "dub-launcher-panel";

async function openLauncher(page: Page): Promise<void> {
  await page.getByTestId(TRIGGER).click();
  await expect(page.getByTestId(PANEL)).toBeVisible();
}

test("Commander tile shows in the launcher and opens the /commander screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();

  // (1) The Commander tile is present in the launcher for the admin demo user.
  await openLauncher(page);
  const tile = page.getByTestId(PANEL).getByRole("option", { name: /Commander/ });
  await expect(tile).toBeVisible();
  await page.screenshot({ path: shot("01-launcher-commander-tile.png") });

  // (2) Opening it navigates to /commander and mounts the console + phase board.
  await tile.click();
  await expect(page).toHaveURL(/\/commander$/);
  await expect(page.getByTestId("fe2-commander")).toBeVisible();
  await expect(page.getByTestId("fe2-commander-console").getByText("実行コンソール")).toBeVisible();
  await expect(page.getByTestId("fe2-commander-board")).toBeVisible();
  await page.screenshot({ path: shot("02-commander-screen.png") });
});
