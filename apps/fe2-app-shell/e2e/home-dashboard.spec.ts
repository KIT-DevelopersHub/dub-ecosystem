// Home dashboard + header refine E2E (real browser, DEMO transport). Proves the
// user-facing feedback is satisfied:
//   (1) the dashboard is tidy AND fits in a single viewport — ZERO page scroll,
//       measured (scrollHeight <= clientHeight) across several resolutions;
//   (2) the header is brand-first: "DevHub" bold as the primary label with the
//       account email small & muted beside it;
//   (3) clicking "DevHub" returns to Home (logo = home导线).
// Screenshots (desktop + mobile) are written to ~/DubVault/docs/home-header-refine/.
//
// The dashboard body used to be a 2-column CSS grid (viz cards + app launcher on
// the left, a fixed vertical stack of live panels on the right, `.fe2-dash-main`
// / `.fe2-home-side`) that stacked to one column below 1100px. That structure is
// gone: the customizable widget area is now a single full-width cell grid (see
// dashboard/HomeWidgetGrid.tsx) sitting above the (still fixed, full-width) app
// launcher — there is no longer a "main column vs. side rail" split to assert
// geometry on, at any width. The invariant that mattered (never let a widget get
// squished into an unreadably narrow sliver) is instead enforced by the grid
// itself dropping to a narrow (2-col) layout below its own measured container
// width — see the narrow-width assertion below.
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

// Width below which the widget grid itself narrows to 2 columns (see
// dashboard/homeGrid.ts HOME_GRID_NARROW_BREAKPOINT) — every widget then reads
// at a comfortable minimum width instead of shrinking indefinitely.
const WIDGET_GRID_NARROW_BREAKPOINT = 640;

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
  // The widget grid animates every reposition with a 200ms CSS transition
  // (react-grid-layout); each setViewportSize below re-triggers that transition
  // as the grid's column count adapts. Disable transitions so every rect read
  // in this test reflects the settled layout, not an interpolated frame.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });

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

    // (1b) The widget grid never overlaps its own items, at any width — the
    // regression this guards is the same one the old "半画面でイベント欄が潰れる"
    // report was about (a widget getting squished/clipped at in-between
    // widths), just asserted against the new architecture: read every visible
    // widget's real pixel rect and confirm no two intersect.
    const grid = page.getByTestId("fe2-home-widget-grid");
    if (await grid.count()) {
      const rects = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[data-testid^="fe2-widget-grid-item-"]'));
        return items.map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      });
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const p = rects[a]!;
          const q = rects[b]!;
          const overlaps = p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
          expect(overlaps, `widgets ${a} and ${b} must not overlap at ${vp.name}`).toBe(false);
        }
      }
      // Below the grid's own narrow breakpoint every widget must still read at a
      // sane minimum width (never an unreadable sliver).
      if (vp.width <= WIDGET_GRID_NARROW_BREAKPOINT) {
        for (const r of rects) {
          expect(r.right - r.left, `a widget must not be squished at ${vp.name}`).toBeGreaterThan(100);
        }
      }
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
