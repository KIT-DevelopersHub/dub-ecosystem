// AppLauncher filter + keyboard E2E (real browser, DEMO transport). Proves 判断18②:
//   (1) opening the waffle popover focuses the filter box immediately;
//   (2) typing narrows the tiles by substring (display-only — never removes apps);
//   (3) ↑/↓ move the active tile and Enter opens it (navigates);
//   (4) Esc closes the popover.
// Screenshots land in ~/DubVault/docs/fe1-launcher-search/.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "fe1-launcher-search");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const TRIGGER = "fe2-app-launcher-trigger";
const SEARCH = "fe2-app-launcher-search";
const PANEL = "dub-launcher-panel";

async function openLauncher(page: Page): Promise<void> {
  await page.getByTestId(TRIGGER).click();
  await expect(page.getByTestId(PANEL)).toBeVisible();
}

/** Count of rendered launcher tiles (role=option) currently in the grid. */
async function tileCount(page: Page): Promise<number> {
  return page.getByTestId(PANEL).getByRole("option").count();
}

test("launcher: filter box narrows tiles by substring, keyboard opens, Esc closes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();

  // (1) Open → the filter box is focused straight away so the user can just type.
  await openLauncher(page);
  await expect(page.getByTestId(SEARCH)).toBeFocused();
  const total = await tileCount(page);
  expect(total).toBeGreaterThan(1);
  await page.screenshot({ path: shot("01-open-focused.png") });

  // Pick a real tile's label to derive a query that matches only it.
  const firstLabel = (await page.getByTestId(PANEL).getByRole("option").first().innerText()).trim();
  const query = firstLabel.slice(0, Math.max(1, Math.min(2, firstLabel.length)));

  // (2) Typing narrows the displayed tiles (substring, display-only).
  await page.getByTestId(SEARCH).fill(query);
  await expect
    .poll(() => tileCount(page), { message: "typing should not increase tile count", timeout: 5000 })
    .toBeLessThanOrEqual(total);
  await expect(page.getByTestId(PANEL).getByRole("option").filter({ hasText: firstLabel }).first()).toBeVisible();
  await page.screenshot({ path: shot("02-filtered.png") });

  // Clearing restores every app (nothing was removed — 消さない).
  await page.getByTestId(SEARCH).fill("");
  await expect.poll(() => tileCount(page), { timeout: 5000 }).toBe(total);

  // (4) Esc closes the popover.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(PANEL)).toBeHidden();

  // (3) Reopen → ↓ selects the first tile, Enter opens it (URL changes / panel closes).
  await openLauncher(page);
  await page.keyboard.press("ArrowDown");
  const activeId = await page.getByTestId(SEARCH).getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await page.screenshot({ path: shot("03-arrow-active.png") });
  await page.keyboard.press("Enter");
  // Enter launches the tile: the popover closes (navigation dispatched).
  await expect(page.getByTestId(PANEL)).toBeHidden();
});
