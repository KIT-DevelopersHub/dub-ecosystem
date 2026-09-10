// Home ダッシュボード「サイドパネル」の面積の異なるウィジェット同士の相互スワップ —
// real browser, DEMO transport. Regression coverage for the bug the user reported
// after demo review of home-widget-area-swap.spec.ts's original scope: that spec
// only ever proves EQUAL-area arrangements via the size picker (小2つ=中1つ) and a
// same-size drag (小⇄小). It never actually DRAGS one differently-sized widget onto
// another — which is exactly what was broken: dnd-kit's built-in sorting strategies
// (`rectSortingStrategy` / `verticalListSortingStrategy`) compute every row's live
// drag-preview transform assuming every item is the SAME size, so with a mixed
// small/medium/large grid the rows between the dragged tile and its drop target got
// wildly wrong preview deltas — a neighbour visibly flew off-position or vanished
// mid-drag — even though the persisted order ended up self-consistent. The fix
// (SortableList `reorderMode="swap"`, HomeEditableRegion.tsx) swaps EXACTLY the
// dragged widget and its drop target (dnd-kit's `rectSwappingStrategy` + `arraySwap`)
// and leaves every other widget untouched — this spec proves that end-to-end for all
// three shapes the user asked for: 中⇄小2つ, 大⇄中2つ, and a same-area (小⇄小) swap.
import { test, expect, type Page } from "@playwright/test";

async function enterEdit(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "true");
}

async function exitEdit(page: Page): Promise<void> {
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");
}

/** Seed the persisted Home layout (sizes only — order/hidden left default) BEFORE
 *  the app boots, then land back on Home. Avoids clicking through the size picker
 *  each test (which itself triggers a grid reflow the drag would then race). */
async function seedSizes(page: Page, sizes: Record<string, "small" | "medium" | "large">): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  // Visit /events once so the "最近開いた" (panel-recent) side panel has an entry —
  // otherwise a fresh session has no visit history and only two of the three side
  // panels render, which is not enough to exercise a three-way region.
  await page.getByTestId("fe2-home-tile-events").click();
  await expect(page).toHaveURL(/\/events/);
  await page.evaluate((s) => {
    localStorage.setItem("dub.ui.home.layout", JSON.stringify({ order: [], hidden: [], sizes: s }));
  }, sizes);
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-home-recent")).toBeVisible();
}

async function dragHandle(page: Page, fromId: string, toId: string): Promise<void> {
  const fromHandle = page.getByTestId(`fe2-widget-handle-${fromId}`);
  const toHandle = page.getByTestId(`fe2-widget-handle-${toId}`);
  const fromBox = await fromHandle.boundingBox();
  const toBox = await toHandle.boundingBox();
  if (!fromBox || !toBox) throw new Error("drag handles not measurable");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 10, fromBox.y + fromBox.height / 2, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 15 });
  await page.waitForTimeout(80);
  await page.mouse.move(toBox.x + toBox.width / 2 + 2, toBox.y + toBox.height / 2 + 2, { steps: 5 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** DOM order of the side rail's widgets while resting (visible-only render — see
 *  HomeEditableRegion's non-editing branch: each child IS the widget's own testid). */
async function restingOrder(page: Page): Promise<(string | null)[]> {
  return page.getByTestId("fe2-home-region-side").evaluate((el) => Array.from(el.children).map((c) => c.getAttribute("data-testid")));
}

test.describe("サイドパネル: 面積の異なるウィジェット同士の相互スワップ (却下修正の回帰)", () => {
  test("中(panel-recent) ⇄ 小2つ(panel-events, panel-notifications) をドラッグで交換 — 未関与のウィジェットは動かない", async ({ page }) => {
    await seedSizes(page, { "panel-recent": "medium", "panel-events": "small", "panel-notifications": "small" });
    await enterEdit(page);

    // Drag the MEDIUM widget directly onto the SECOND small widget (skipping past the
    // first small one) — the scenario that broke: a neighbour between drag start and
    // drop target used to fly off / vanish mid-drag.
    await dragHandle(page, "panel-recent", "panel-notifications");
    await exitEdit(page);

    const order = await restingOrder(page);
    // True swap: recent <-> notifications trade places; events (untouched) keeps its spot.
    // Catalog order is [recent, events, notifications] — events sits at index 1 (the
    // MIDDLE) before any drag. A true swap only trades the two ends (recent<->
    // notifications) and must leave events exactly where it already was.
    expect(order.indexOf("fe2-home-events")).toBe(1);
    expect(order.indexOf("fe2-home-notifications")).toBeLessThan(order.indexOf("fe2-home-recent"));

    // Sizes travel WITH the widget, not the slot.
    await enterEdit(page);
    await expect(page.getByTestId("fe2-widget-size-panel-recent-medium")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("fe2-widget-size-panel-events-small")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("fe2-widget-size-panel-notifications-small")).toHaveAttribute("aria-selected", "true");
    await exitEdit(page);

    await page.screenshot({ path: "/Users/kota/Desktop/dub-widget-swap-medium-vs-2small.png", fullPage: true });

    // Persistence: reload and the swapped order survives.
    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const reloadedOrder = await restingOrder(page);
    expect(reloadedOrder).toEqual(order);
  });

  test("大(panel-recent) ⇄ 中2つ(panel-events, panel-notifications) をドラッグで交換 — 未関与のウィジェットは動かない", async ({ page }) => {
    await seedSizes(page, { "panel-recent": "large", "panel-events": "medium", "panel-notifications": "medium" });
    await enterEdit(page);

    // Drag the LARGE widget past the first medium onto the second — the far target.
    await dragHandle(page, "panel-recent", "panel-notifications");
    await exitEdit(page);

    const order = await restingOrder(page);
    expect(order.indexOf("fe2-home-events")).toBe(1); // untouched middle widget keeps its spot
    expect(order.indexOf("fe2-home-notifications")).toBeLessThan(order.indexOf("fe2-home-recent"));

    await enterEdit(page);
    await expect(page.getByTestId("fe2-widget-size-panel-recent-large")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("fe2-widget-size-panel-events-medium")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("fe2-widget-size-panel-notifications-medium")).toHaveAttribute("aria-selected", "true");
    await exitEdit(page);

    await page.screenshot({ path: "/Users/kota/Desktop/dub-widget-swap-large-vs-2medium.png", fullPage: true });

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const reloadedOrder = await restingOrder(page);
    expect(reloadedOrder).toEqual(order);
  });

  test("同面積どうし(小⇄小)の相互入れ替えも引き続き正しく動く", async ({ page }) => {
    await seedSizes(page, { "panel-recent": "small", "panel-events": "large", "panel-notifications": "small" });
    await enterEdit(page);

    await dragHandle(page, "panel-recent", "panel-notifications");
    await exitEdit(page);

    const order = await restingOrder(page);
    // recent and notifications (both small) trade places; the large events (untouched)
    // still sits between them in the underlying order.
    expect(order.indexOf("fe2-home-notifications")).toBeLessThan(order.indexOf("fe2-home-events"));
    expect(order.indexOf("fe2-home-events")).toBeLessThan(order.indexOf("fe2-home-recent"));

    await page.screenshot({ path: "/Users/kota/Desktop/dub-widget-swap-same-area.png", fullPage: true });

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const reloadedOrder = await restingOrder(page);
    expect(reloadedOrder).toEqual(order);
  });
});
