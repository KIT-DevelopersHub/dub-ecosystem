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

  // (2) Opening it navigates to /commander and mounts the same workspace as the standalone
  // Commander (ボード / Dubに聞く / Dubを操作 tabs).
  await tile.click();
  await expect(page).toHaveURL(/\/commander$/);
  await expect(page.getByTestId("fe2-commander")).toBeVisible();
  const ws = page.getByTestId("fe2-commander-workspace");
  await expect(ws.getByTestId("tab-board")).toBeVisible();
  await expect(ws.getByTestId("tab-ask")).toBeVisible();
  await expect(ws.getByTestId("tab-operate")).toBeVisible();
  await expect(ws.getByTestId("panel-board")).toBeVisible();
  await page.screenshot({ path: shot("02-commander-screen.png") });
});

test("a remote (tunnel) connection is checked, saved on this device, and can be reset", async ({ page }) => {
  const API = "https://commander-api.example.jp";
  // Stand-in for the operator's tunnel: only the right token unlocks the board.
  await page.route(`${API}/**`, (route) => {
    const ok = route.request().headers()["x-commander-token"] === "right-token";
    return route.fulfill({
      status: ok ? 200 : 401,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(ok ? { items: [], features: [], runs: [], sessions: [] } : { error: "unauthorized" }),
    });
  });
  await page.route("https://commander-daemon.example.jp/**", (route) =>
    route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "{}" }),
  );

  await page.goto("/commander");
  const card = page.getByTestId("fe2-commander-connection");
  await expect(card).toContainText("このPC（127.0.0.1）");
  await card.getByTestId("fe2-commander-connection-edit").click();

  // Plain http to a remote host is refused (the token would travel in clear).
  await page.getByTestId("fe2-cmdr-daemon").fill("http://commander-daemon.example.jp");
  await expect(card.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("fe2-commander-connection-save")).toBeDisabled();

  await page.getByTestId("fe2-cmdr-daemon").fill("https://commander-daemon.example.jp");
  await page.getByTestId("fe2-cmdr-api").fill(API);
  await page.getByTestId("fe2-cmdr-token").fill("wrong-token");
  await page.getByTestId("fe2-commander-connection-save").click();
  await expect(page.getByTestId("fe2-commander-connection-status")).toHaveText("トークンが違います");

  await page.getByTestId("fe2-cmdr-token").fill("right-token");
  await page.getByTestId("fe2-commander-connection-save").click();
  await expect(page.getByTestId("fe2-commander-connection-mode")).toHaveText("commander-api.example.jp");
  await expect(card).toContainText("リモート（トンネル経由）");
  await page.screenshot({ path: shot("03-commander-remote-connected.png") });

  // Persisted per device: survives a reload.
  await page.reload();
  await expect(page.getByTestId("fe2-commander-connection-mode")).toHaveText("commander-api.example.jp");

  await page.getByTestId("fe2-commander-connection-edit").click();
  await page.getByTestId("fe2-commander-connection-reset").click();
  await expect(card).toContainText("このPC（127.0.0.1）");
});
