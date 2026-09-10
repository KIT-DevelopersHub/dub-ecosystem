// Home ダッシュボード「サイドパネル」の面積等価スワップ — real browser, DEMO transport.
//
// homeLayout.test.ts already proves the underlying invariant in isolation (小1 =
// 中の1/2 = 大の1/4 cell-area) and the KPI-row spec already proves resize + drag +
// keyboard + persistence work on a 6-column grid. What neither proves is the thing
// the user actually asked for: in the REAL right-rail grid (`fe2-home-side`, 2
// columns, `grid-auto-flow: dense`), can a viewer literally put two 小 side by side
// where one 中 used to be, sit a 大ядом with them, drag-swap them, and have it
// survive reload — with no gaps / overlaps (dense-fill actually back-filling, not
// just the span CSS existing)? This spec drives exactly that.
import { test, expect, type Page } from "@playwright/test";

async function enterEdit(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" }); // freeze the 編集モード jiggle (see home-widget-edit.spec.ts)
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "true");
}

async function exitEdit(page: Page): Promise<void> {
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");
}

function setSize(page: Page, widgetId: string, size: "small" | "medium" | "large") {
  return page.getByTestId(`fe2-widget-size-${widgetId}-${size}`).click();
}

/** Bounding boxes (RESTING dashboard, not 編集モード) of the side-rail panels, keyed
 *  by widget id, read straight off the DOM so we can assert real pixel geometry —
 *  no overlaps, and a 2-小 row occupying the same footprint as a 中 row. */
async function sideBoxes(page: Page): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  const region = page.getByTestId("fe2-home-region-side");
  const ids = ["fe2-home-recent", "fe2-home-events", "fe2-home-notifications"];
  const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const id of ids) {
    const el = region.getByTestId(id);
    if (await el.count()) {
      const box = await el.boundingBox();
      if (box) out[id] = box;
    }
  }
  return out;
}

test("サイドパネル: 小2つ=中1つ・大隣接の混在をdenseで詰め、ドラッグで入れ替え、リロードで保持", async ({ page }) => {
  // A tall-enough viewport so the whole side rail renders without the dashboard's own
  // internal scroll region collapsing (the default 1280x720 headless viewport is short
  // enough that this app's flex/scroll shell can leave a widget below the fold, which
  // makes its handle unreachable to a raw pointer drag at those coordinates).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();

  // Seed a "最近開いた" (panel-recent) entry so all THREE side-rail panels are in
  // play (recent / events / notifications) — otherwise a fresh session has no visit
  // history and the rail only has two, which is not enough to show a 大 next to a
  // 小+小 pair. Visiting any trackable page records it (P3-1); coming straight back
  // to Home is enough for the entry to exist.
  await page.getByTestId("fe2-home-tile-events").click();
  await expect(page).toHaveURL(/\/events/);
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-home-recent")).toBeVisible();

  await enterEdit(page);

  // Every side panel defaults to 中 (medium) — matches the pre-P3-4 stacked look.
  await expect(page.getByTestId("fe2-widget-size-panel-recent-medium")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fe2-widget-size-panel-events-medium")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fe2-widget-size-panel-notifications-medium")).toHaveAttribute("aria-selected", "true");

  // ── build the mixed layout: 直近のイベント(大) + 最近開いた(小) + 未読の通知(小) ──
  // Catalog order is [panel-recent, panel-events, panel-notifications]; making the
  // MIDDLE one 大 while its neighbours go 小 forces dense-fill to backtrack and slot
  // the two 小 into the row that would otherwise sit half-empty next to 大 — the
  // exact "小2つが中1つ分の場所を埋める" behavior, proven with real pixels below.
  await setSize(page, "panel-events", "large");
  await expect(page.getByTestId("fe2-widget-size-panel-events-large")).toHaveAttribute("aria-selected", "true");
  await setSize(page, "panel-recent", "small");
  await setSize(page, "panel-notifications", "small");
  await expect(page.getByTestId("fe2-widget-size-panel-recent-small")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fe2-widget-size-panel-notifications-small")).toHaveAttribute("aria-selected", "true");

  await exitEdit(page);

  // ── real-pixel assertions on the RESTING dashboard ─────────────────────────────
  const boxes = await sideBoxes(page);
  const recent = boxes["fe2-home-recent"];
  const notif = boxes["fe2-home-notifications"];
  const events = boxes["fe2-home-events"];
  expect(recent && notif && events).toBeTruthy();
  if (!recent || !notif || !events) throw new Error("side panels not measurable");

  // 小 + 小 sit on the SAME row (same y, roughly), side by side (different x), and
  // together span the same width as 大/中 (full rail width) — i.e. exactly the
  // footprint one 中 would have occupied. No dense-fill gap between them.
  expect(Math.abs(recent.y - notif.y)).toBeLessThan(4);
  expect(Math.abs(recent.x - notif.x)).toBeGreaterThan(recent.width / 2); // distinct columns
  const combinedSmallWidth = Math.abs(notif.x + notif.width - recent.x);
  expect(Math.abs(combinedSmallWidth - events.width)).toBeLessThan(8); // 小+小 ≈ 大/中 の全幅

  // 大 (events) actually carries a 2x2 grid span (row tracks are content-auto-sized,
  // not a fixed pixel height, so we assert the GRID SPAN itself — the real area
  // contract — rather than a pixel ratio that content height would make flaky).
  const eventsRowSpan = await page
    .getByTestId("fe2-home-events")
    .evaluate((el) => getComputedStyle(el).gridRowEnd);
  expect(eventsRowSpan).toContain("span 2");
  const smallRowSpan = await page
    .getByTestId("fe2-home-recent")
    .evaluate((el) => getComputedStyle(el).gridRowEnd);
  expect(smallRowSpan).toContain("span 1");

  // No dense-fill collision: 大 does not overlap the 小+小 row placed beside/above it.
  const noOverlap = events.y >= recent.y + recent.height - 2 || recent.y >= events.y + events.height - 2;
  expect(noOverlap).toBe(true);

  await page.screenshot({ path: "/Users/kota/Desktop/dub-home-widget-area-swap.png", fullPage: true });

  // ── drag-swap: move 未読の通知(小) to the front, past 直近のイベント(大) ─────────
  await enterEdit(page);
  const fromHandle = page.getByTestId("fe2-widget-handle-panel-notifications");
  const toHandle = page.getByTestId("fe2-widget-handle-panel-recent");
  const fromBox = await fromHandle.boundingBox();
  const toBox = await toHandle.boundingBox();
  if (!fromBox || !toBox) throw new Error("drag handles not measurable");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 10, fromBox.y + fromBox.height / 2, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  await exitEdit(page);

  // 未読の通知 now renders before 最近開いた in DOM order (the swap actually moved it).
  const region = page.getByTestId("fe2-home-region-side");
  const order = await region.evaluate((el) =>
    Array.from(el.children)
      .map((c) => c.getAttribute("data-testid"))
      .filter((t): t is string => !!t),
  );
  expect(order.indexOf("fe2-home-notifications")).toBeLessThan(order.indexOf("fe2-home-recent"));
  // Sizes travel WITH the widget, not the slot — 未読の通知 is still 小 (span 1) after moving.
  const notifRowSpanAfterSwap = await page
    .getByTestId("fe2-home-notifications")
    .evaluate((el) => getComputedStyle(el).gridRowEnd);
  expect(notifRowSpanAfterSwap).toContain("span 1");

  // ── persistence: reload and both the sizes and the new order survive ──────────
  await page.reload();
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await enterEdit(page);
  await expect(page.getByTestId("fe2-widget-size-panel-events-large")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fe2-widget-size-panel-recent-small")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("fe2-widget-size-panel-notifications-small")).toHaveAttribute("aria-selected", "true");
  const reloadedOrder = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="fe2-home-region-side"]');
    return el
      ? Array.from(el.children)
          .map((c) => c.querySelector("[data-testid]")?.getAttribute("data-testid") ?? c.getAttribute("data-testid"))
          .filter(Boolean)
      : [];
  });
  expect(reloadedOrder.indexOf("fe2-widget-edit-panel-notifications")).toBeLessThan(
    reloadedOrder.indexOf("fe2-widget-edit-panel-recent"),
  );
});
