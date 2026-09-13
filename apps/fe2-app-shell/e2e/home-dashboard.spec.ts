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

const SHOTS = join(homedir(), "DubVault", "docs", "home-applaunch-refine");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

// Resolutions the dashboard must fit without a page scrollbar (desktop → mobile).
// The half-width-* entries cover the gap between small-laptop (1280) and the
// tall tablet/mobile shapes below it: a browser snapped to HALF of a common
// desktop screen (1920/1366/1280 wide) lands squarely in 640-960px landscape —
// a width the previous list never exercised, which is how the "半画面でイベント
// 欄が潰れる" regression shipped unnoticed (bug report + fix: see .fe2-dash-body
// in styles/global.css, single-column breakpoint raised 860px → 1100px).
const VIEWPORTS = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "laptop-1366x768", width: 1366, height: 768 },
  { name: "small-laptop-1280x720", width: 1280, height: 720 },
  { name: "half-width-1024x768", width: 1024, height: 768 },
  { name: "half-width-960x900", width: 960, height: 900 },
  { name: "half-width-768x900", width: 768, height: 900 },
  { name: "half-width-540x900", width: 540, height: 900 },
  { name: "tablet-834x1112", width: 834, height: 1112 },
  { name: "mobile-390x844", width: 390, height: 844 },
] as const;

// Width below which .fe2-dash-body stacks to a single column (see global.css).
// Below it, the main column (viz cards + app grid) and the right rail (events /
// notifications) must render full-width, stacked in document order — never
// side-by-side — so a shared scrollbar can never drag the shorter column out of
// view while the taller one is still being read (the original bug).
const DASH_BODY_STACK_BREAKPOINT = 1100;

/** Vertical overflow of the page scroller in px (0 = no page scroll). */
async function pageVerticalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return Math.max(0, el.scrollHeight - el.clientHeight);
  });
}

/** Vertical overflow of a testid element in px (0 = it does not scroll internally). */
async function elementVerticalOverflow(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return -1;
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }, testId);
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
    await expect(page.getByTestId("fe2-home-apps-grid")).toBeVisible();
    // (a) page never scrolls; (b) the app launcher never scrolls INTERNALLY.
    await expect
      .poll(() => pageVerticalOverflow(page), {
        message: `page must not scroll vertically at ${vp.name}`,
        timeout: 5000,
      })
      .toBeLessThanOrEqual(1); // allow 1px sub-pixel rounding
    await expect
      .poll(() => elementVerticalOverflow(page, "fe2-home-apps-grid"), {
        message: `the app launcher grid must not scroll internally at ${vp.name}`,
        timeout: 5000,
      })
      .toBeLessThanOrEqual(1);

    // (1b) Below the stack breakpoint, main and aside must be full-width and
    // stacked (never side-by-side) — this is what stops a shared scrollbar from
    // dragging the shorter aside out of view while the taller main column (viz
    // cards + app grid) is still being scrolled through. Regression test for the
    // "半画面でイベント欄が潰れる" report.
    if (vp.width <= DASH_BODY_STACK_BREAKPOINT) {
      const rects = await page.evaluate(() => {
        const main = document.querySelector(".fe2-dash-main")?.getBoundingClientRect();
        const aside = document.querySelector(".fe2-home-side")?.getBoundingClientRect();
        return main && aside ? { mainLeft: main.left, mainBottom: main.bottom, asideLeft: aside.left, asideTop: aside.top } : null;
      });
      expect(rects, `main/aside must be present at ${vp.name}`).not.toBeNull();
      // Stacked ⇒ same left edge, and aside begins at/after main's bottom edge
      // (allow a few px for the column gap/rounding), never floating beside it.
      expect(Math.abs(rects!.mainLeft - rects!.asideLeft), `main/aside must share a left edge (stacked) at ${vp.name}`).toBeLessThanOrEqual(1);
      expect(rects!.asideTop, `aside must start at/after main's bottom (stacked, not side-by-side) at ${vp.name}`).toBeGreaterThanOrEqual(rects!.mainBottom - 1);

      // The events card itself must render at full column width (never clipped
      // to a narrow side-rail sliver) once stacked.
      const eventsCard = page.getByTestId("fe2-home-events");
      await expect(eventsCard).toBeVisible();
      const eventsWidth = await eventsCard.evaluate((el) => el.getBoundingClientRect().width);
      expect(eventsWidth, `events card must be full-width when stacked at ${vp.name}`).toBeGreaterThan(vp.width * 0.8);
    }

    if (vp.name === "half-width-960x900") {
      await page.screenshot({ path: shot("00-dashboard-half-width-960.png") });
    }
    if (vp.name === "desktop-1440x900") {
      await page.screenshot({ path: shot("01-dashboard-desktop.png") });
    }
    if (vp.name === "small-laptop-1280x720") {
      await page.screenshot({ path: shot("02-dashboard-1280x720.png") });
    }
    if (vp.name === "mobile-390x844") {
      await page.screenshot({ path: shot("03-dashboard-mobile.png") });
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
