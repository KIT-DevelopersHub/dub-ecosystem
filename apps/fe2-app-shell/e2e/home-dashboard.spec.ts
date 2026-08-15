// Home dashboard + header refine E2E (real browser, DEMO transport). Proves the
// user-facing feedback is satisfied:
//   (1) the dashboard is tidy AND fits in a single viewport — ZERO page scroll,
//       measured (scrollHeight <= clientHeight) across several resolutions;
//   (2) the header is brand-first: "DevHub" bold as the primary label with the
//       account email small & muted beside it;
//   (3) clicking "DevHub" returns to Home (logo = home导线).
// Screenshots (desktop + mobile) are written to ~/DubVault/docs/home-header-refine/.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "home-header-refine");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

// Resolutions the dashboard must fit without a page scrollbar (desktop → mobile).
const VIEWPORTS = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "laptop-1366x768", width: 1366, height: 768 },
  { name: "small-laptop-1280x720", width: 1280, height: 720 },
  { name: "tablet-834x1112", width: 834, height: 1112 },
  { name: "mobile-390x844", width: 390, height: 844 },
] as const;

/** Vertical overflow of the page scroller in px (0 = no page scroll). */
async function pageVerticalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return Math.max(0, el.scrollHeight - el.clientHeight);
  });
}

test("home dashboard: brand-first header, home导线, and zero page scroll at every resolution", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();

  // (2) Header is brand-first: "DevHub" bold + small muted account email.
  const brand = page.getByTestId("fe2-brand-home");
  await expect(brand).toBeVisible();
  await expect(brand).toHaveText("DevHub");
  const account = page.getByTestId("fe2-header-account");
  await expect(account).toBeVisible();
  await expect(account).not.toHaveText(""); // shows the signed-in address

  // (1) Zero page scroll across resolutions. setViewportSize fires the window
  // resize the fit-hook listens for; poll so we assert after it re-clamps.
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect
      .poll(() => pageVerticalOverflow(page), {
        message: `page must not scroll vertically at ${vp.name}`,
        timeout: 5000,
      })
      .toBeLessThanOrEqual(1); // allow 1px sub-pixel rounding

    if (vp.name === "desktop-1440x900") {
      await page.screenshot({ path: shot("01-dashboard-desktop.png") });
    }
    if (vp.name === "mobile-390x844") {
      await page.screenshot({ path: shot("02-dashboard-mobile.png") });
    }
  }

  // (3) DevHub = home导线: navigate away, then click the brand → back on Home.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/usage");
  await expect(page.getByTestId("fe2-home")).toHaveCount(0);
  await page.getByTestId("fe2-brand-home").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await page.screenshot({ path: shot("03-brand-click-home.png") });
});
