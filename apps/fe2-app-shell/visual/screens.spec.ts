// App-screen visual regression over the main fe2 screens (demo transport).
//
// Each screen: fresh context → frozen clock → goto → settle (skeletons gone, fonts
// ready, motion killed) → optional interaction → full-viewport screenshot.
// Screens tagged @mobile also run in the 390px `mobile` project.
import { test, expect, type Locator, type Page } from "@playwright/test";

// Demo seed derives most dates from Date.now(); freezing it makes relative labels
// ("4日前", countdowns, calendar "today", now-line) stable. Monday 10:00 JST.
const FIXED_NOW = new Date("2026-06-15T10:00:00+09:00");

const KILL_MOTION =
  "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";

// Loading placeholders that must be gone before capture.
const SKELETONS = '[data-testid*="skeleton"], .dub-skeleton-shimmer';

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: KILL_MOTION });
  await expect(page.locator(SKELETONS)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  // Lazy chunks / demo fetches resolve on microtasks + timers; give the tree two frames.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

type Screen = {
  name: string;
  path: string;
  ready: string; // testid that proves the screen mounted
  mobile?: boolean;
  act?: (page: Page) => Promise<void>;
  mask?: (page: Page) => Locator[];
};

const SCREENS: Screen[] = [
  { name: "home", path: "/", ready: "fe2-home", mobile: true },
  {
    name: "launcher-open",
    path: "/",
    ready: "fe2-home",
    act: async (page) => {
      await page.getByTestId("fe2-app-launcher-trigger").click();
      await expect(page.getByTestId("dub-launcher-panel")).toBeVisible();
    },
  },
  { name: "mail-inbox", path: "/mail", ready: "fe2-mail-inbox", mobile: true },
  {
    name: "mail-thread",
    path: "/mail",
    ready: "fe2-mail-inbox",
    act: async (page) => {
      await page.getByTestId("fe2-mail-inbox-item").filter({ hasText: "スポンサー契約書の送付" }).click();
      await expect(page.getByTestId("fe2-mail-thread")).toBeVisible();
    },
  },
  {
    name: "chat",
    path: "/chat",
    ready: "fe6-channel-timeline",
    // Demo has no realtime socket; the banner's wording races connect/disconnect.
    mask: (page) => [page.getByTestId("fe6-channel-connection-banner")],
  },
  { name: "tasks-my", path: "/me/tasks", ready: "fe4-mytasks-list", mobile: true },
  { name: "calendar", path: "/calendar", ready: "fe2-calendar" },
  { name: "notifications", path: "/notifications", ready: "fe5-inbox-list" },
];

test.describe("fe2 app screens", () => {
  for (const s of SCREENS) {
    test(`${s.name}${s.mobile ? " @mobile" : ""}`, async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      await page.goto(s.path);
      await expect(page.getByTestId(s.ready).first()).toBeVisible();
      await settle(page);
      if (s.act) {
        await s.act(page);
        await settle(page);
      }
      await expect(page).toHaveScreenshot(`${s.name}.png`, {
        mask: s.mask?.(page) ?? [],
      });
    });
  }
});
