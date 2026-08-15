// Usage (無料枠 / 課金ガード) dashboard E2E — real browser, DEMO transport, against the
// PRODUCTION Vite build (minified + code-split). This is the pre-deploy white-screen gate:
// a green typecheck/unit run does NOT catch a runtime bundle error that blanks the SPA.
// Proves (a) the screen renders (not white), (b) free-tier cards show real %-values (not
// the "取得不可" unknown state), (c) zero console errors.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("usage dashboard renders real %-values (not 取得不可) with no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto("/usage");

  // (a) the screen is drawn — not a white/blank crash.
  await expect(page.getByTestId("fe2-usage-dashboard")).toBeVisible();
  await expect(page.getByTestId("fe2-usage-groups")).toBeVisible();

  // (b) at least one free-tier card shows a real percentage, NOT the unknown "取得不可" state.
  const pct = page.getByTestId("fe2-usage-card-workers_requests_day-pct");
  await expect(pct).toBeVisible();
  await expect(pct).toContainText("%");
  await expect(pct).not.toContainText("取得不可");

  // The board shows REAL metered values — most cards resolve to a known status (ok/warn/
  // critical), not the "取得不可" blank. (The demo snapshot keeps a couple of "unknown"
  // cards on purpose to exercise that state; the point of this gate is that the board is
  // NOT all-unknown — the exact production regression being fixed.)
  const allCards = page.locator('[data-testid^="fe2-usage-card-"][data-status]');
  const knownCards = page.locator(
    '[data-testid^="fe2-usage-card-"][data-status="ok"], [data-testid^="fe2-usage-card-"][data-status="warn"], [data-testid^="fe2-usage-card-"][data-status="critical"]',
  );
  const total = await allCards.count();
  const known = await knownCards.count();
  expect(total).toBeGreaterThan(0);
  expect(known).toBeGreaterThan(total / 2); // the board is real values, not a blanked "取得不可" wall

  await page.screenshot({ path: shot("usage-dashboard.png"), fullPage: true });

  // (c) no runtime errors leaked to the console.
  expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
});
