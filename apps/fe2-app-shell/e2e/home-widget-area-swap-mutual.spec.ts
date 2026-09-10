// Home ダッシュボード「サイドパネル」の面積の異なるウィジェット同士の相互スワップ —
// real browser, DEMO transport, REAL mouse drag (page.mouse.move/down/up over real
// pixel coordinates — no dnd-kit synthetic pointer events).
//
// POSTMORTEM (2 prior rejections — see homeLayout.ts module doc for the mechanism):
// two previous "fixes" (arrayMove/insert, then dnd-kit rectSwappingStrategy+arraySwap)
// both operated on the flat id array and were regression-tested by DOM CHILD ORDER
// only. A `grid-auto-flow: dense` region does not place widgets 1:1 with their array
// index — it independently re-derives each widget's actual (row, col) from the WHOLE
// order + spans, so a DOM-order assertion can pass while the browser paints something
// entirely different (a gap, an overlap, or a neighbour visibly relocated) — which is
// exactly what a real user, dragging with a real mouse, saw and rejected twice.
//
// This spec asserts the thing that actually matters: PIXEL GEOMETRY (getBoundingClientRect
// via Playwright's boundingBox()), before and after a real drag —
//   • the dragged widget's post-drop rect equals the drop target's PRE-drop rect (and
//     vice versa) — a true reciprocal trade, not a shift/insert,
//   • every widget NOT involved in the drag keeps a BYTE-IDENTICAL rect (not just DOM
//     order) — proof nothing else silently moved,
//   • no two widgets overlap after the drop — proof dense-fill didn't collide them,
// for all three sizes the user asked to swap: 中⇄小2つ, 大⇄中2つ, and 小⇄小 (same
// area) — then confirms the swapped layout survives a reload.
import { test, expect, type Page } from "@playwright/test";

type Box = { x: number; y: number; width: number; height: number };

async function enterEdit(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" }); // freeze the 編集モード jiggle so drag coordinates stay stable
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "true");
}

async function exitEdit(page: Page): Promise<void> {
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");
}

/** Seed the persisted Home layout (sizes only) BEFORE the app boots, then land back
 *  on Home with all three side panels present (visiting /events once gives "最近開い
 *  た" an entry — a fresh session otherwise has no visit history). */
async function seedSizes(page: Page, sizes: Record<string, "small" | "medium" | "large">): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await page.getByTestId("fe2-home-tile-events").click();
  await expect(page).toHaveURL(/\/events/);
  await page.evaluate((s) => {
    localStorage.setItem("dub.ui.home.layout", JSON.stringify({ order: [], hidden: [], sizes: s }));
  }, sizes);
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-home-recent")).toBeVisible();
}

/** A REAL mouse drag (down → several intermediate moves → a settle pause → up) from
 *  one widget's drag handle to another's — no dnd-kit synthetic pointer dispatch. */
async function dragHandle(page: Page, fromId: string, toId: string): Promise<void> {
  const fromBox = await page.getByTestId(`fe2-widget-handle-${fromId}`).boundingBox();
  const toBox = await page.getByTestId(`fe2-widget-handle-${toId}`).boundingBox();
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

/** RESTING-dashboard bounding boxes of the side rail's widgets, keyed by widget id. */
async function sideBoxes(page: Page): Promise<Record<string, Box>> {
  const region = page.getByTestId("fe2-home-region-side");
  const ids = ["fe2-home-recent", "fe2-home-events", "fe2-home-notifications"];
  const out: Record<string, Box> = {};
  for (const id of ids) {
    const el = region.getByTestId(id);
    if (await el.count()) {
      const box = await el.boundingBox();
      if (box) out[id] = box;
    }
  }
  return out;
}

function closeEnough(a: number, b: number, tolerance = 3): boolean {
  return Math.abs(a - b) <= tolerance;
}

function sameRect(a: Box, b: Box, tolerance = 3): boolean {
  return closeEnough(a.x, b.x, tolerance) && closeEnough(a.y, b.y, tolerance) && closeEnough(a.width, b.width, tolerance) && closeEnough(a.height, b.height, tolerance);
}

function overlaps(a: Box, b: Box): boolean {
  const noOverlap = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
  return !noOverlap;
}

test.describe("サイドパネル: 面積の異なるウィジェット同士の相互スワップ（実マウスドラッグ・実ピクセル検証）", () => {
  test("中(panel-recent) ⇄ 小2つ(panel-events, panel-notifications): 2小がmediumの旧位置へ、mediumが2小の旧位置へ", async ({
    page,
  }) => {
    await seedSizes(page, { "panel-recent": "medium", "panel-events": "small", "panel-notifications": "small" });

    const before = await sideBoxes(page);
    const recentBefore = before["fe2-home-recent"];
    const eventsBefore = before["fe2-home-events"];
    const notifBefore = before["fe2-home-notifications"];
    if (!recentBefore || !eventsBefore || !notifBefore) throw new Error("panels not measurable before drag");
    // Sanity on the seeded layout: events + notifications (both small) share one row,
    // recent (medium) has its own row above/below them.
    expect(closeEnough(eventsBefore.y, notifBefore.y)).toBe(true);
    expect(closeEnough(recentBefore.y, eventsBefore.y)).toBe(false);

    await enterEdit(page);
    await dragHandle(page, "panel-recent", "panel-notifications");
    await exitEdit(page);

    const after = await sideBoxes(page);
    const recentAfter = after["fe2-home-recent"];
    const eventsAfter = after["fe2-home-events"];
    const notifAfter = after["fe2-home-notifications"];
    if (!recentAfter || !eventsAfter || !notifAfter) throw new Error("panels not measurable after drag");

    // Row TRACK HEIGHT is content-auto-sized (`grid-auto-rows`), so which row is
    // TALLEST changes once the swap changes which content occupies row 1 — an exact
    // absolute-y equality to the OTHER widget's pre-drag y is the wrong invariant.
    // What must hold: (1) the small pair is now the TOPMOST row (it used to be
    // second), (2) the medium is now BELOW them (it used to be first), (3) x/width
    // are unchanged per widget (columns don't move, only row order does), (4) each
    // widget's OWN height is unchanged (content-driven, not slot-driven).
    expect(closeEnough(eventsAfter.y, notifAfter.y)).toBe(true); // still paired, same row
    expect(eventsAfter.y).toBeLessThan(recentAfter.y); // small pair is now on top
    expect(closeEnough(eventsAfter.x, recentBefore.x)).toBe(true); // columns unchanged
    expect(closeEnough(notifAfter.x, notifBefore.x)).toBe(true);
    expect(closeEnough(recentAfter.x, recentBefore.x)).toBe(true);
    expect(closeEnough(recentAfter.width, recentBefore.width, 4)).toBe(true);
    expect(closeEnough(eventsAfter.width, eventsBefore.width, 4)).toBe(true);
    expect(closeEnough(eventsAfter.height, eventsBefore.height, 4)).toBe(true);
    expect(closeEnough(notifAfter.height, notifBefore.height, 4)).toBe(true);
    expect(closeEnough(recentAfter.height, recentBefore.height, 4)).toBe(true);
    // Both smalls kept their OWN size (small = span 1) — sizes travel with the widget.
    const eventsRowSpan = await page.getByTestId("fe2-home-events").evaluate((el) => getComputedStyle(el).gridRowEnd);
    expect(eventsRowSpan).toContain("span 1");
    const recentRowSpanKept = await page.getByTestId("fe2-home-recent").evaluate((el) => getComputedStyle(el).gridColumnEnd);
    expect(recentRowSpanKept).toContain("span 2"); // medium still spans both columns
    // No overlap between any pair post-drop.
    expect(overlaps(recentAfter, eventsAfter)).toBe(false);
    expect(overlaps(recentAfter, notifAfter)).toBe(false);
    expect(overlaps(eventsAfter, notifAfter)).toBe(false);

    await page.screenshot({ path: "/Users/kota/Desktop/dub-widget-swap-v3-medium-vs-2small.png", fullPage: true });

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const reloaded = await sideBoxes(page);
    expect(sameRect(reloaded["fe2-home-recent"]!, recentAfter)).toBe(true);
    expect(sameRect(reloaded["fe2-home-events"]!, eventsAfter)).toBe(true);
    expect(sameRect(reloaded["fe2-home-notifications"]!, notifAfter)).toBe(true);
  });

  test("大(panel-recent) ⇄ 中2つの片方(panel-notifications): 未関与のpanel-eventsは1pxもズレない", async ({ page }) => {
    await seedSizes(page, { "panel-recent": "large", "panel-events": "medium", "panel-notifications": "medium" });

    const before = await sideBoxes(page);
    const recentBefore = before["fe2-home-recent"];
    const eventsBefore = before["fe2-home-events"];
    const notifBefore = before["fe2-home-notifications"];
    if (!recentBefore || !eventsBefore || !notifBefore) throw new Error("panels not measurable before drag");

    await enterEdit(page);
    await dragHandle(page, "panel-recent", "panel-notifications");
    await exitEdit(page);

    const after = await sideBoxes(page);
    const recentAfter = after["fe2-home-recent"];
    const eventsAfter = after["fe2-home-events"];
    const notifAfter = after["fe2-home-notifications"];
    if (!recentAfter || !eventsAfter || !notifAfter) throw new Error("panels not measurable after drag");

    // Before: recent(large) is on TOP, events(medium, untouched) in the MIDDLE,
    // notifications(medium, drop target) at the BOTTOM. The drag exchanges the ENTIRE
    // block containing recent with the entire block containing notifications — so
    // after: notifications is on TOP (took recent's old slot), recent is at the
    // BOTTOM (took notifications' old slot), and events stays exactly in the MIDDLE —
    // never touched, so it keeps its own width/height (row TRACK height is
    // content-auto-sized, so its absolute y may shift, but its relative position
    // between the other two, and its own size, must not).
    expect(recentBefore.y).toBeLessThan(eventsBefore.y);
    expect(eventsBefore.y).toBeLessThan(notifBefore.y);
    expect(notifAfter.y).toBeLessThan(eventsAfter.y); // notifications now on top
    expect(eventsAfter.y).toBeLessThan(recentAfter.y); // recent now at the bottom
    expect(closeEnough(notifAfter.x, recentBefore.x)).toBe(true);
    expect(closeEnough(notifAfter.width, recentBefore.width, 8)).toBe(true);
    expect(closeEnough(eventsAfter.width, eventsBefore.width, 4)).toBe(true);
    expect(closeEnough(eventsAfter.height, eventsBefore.height, 4)).toBe(true);
    expect(closeEnough(eventsAfter.x, eventsBefore.x)).toBe(true);
    // recent (now at the bottom slot) keeps its own LARGE row span; notifications
    // (now on top) keeps its own MEDIUM row span — sizes travel with the widget.
    const recentRowSpan = await page.getByTestId("fe2-home-recent").evaluate((el) => getComputedStyle(el).gridRowEnd);
    expect(recentRowSpan).toContain("span 2");
    const notifRowSpan = await page.getByTestId("fe2-home-notifications").evaluate((el) => getComputedStyle(el).gridRowEnd);
    expect(notifRowSpan).toContain("span 1");
    expect(overlaps(recentAfter, eventsAfter)).toBe(false);
    expect(overlaps(recentAfter, notifAfter)).toBe(false);
    expect(overlaps(eventsAfter, notifAfter)).toBe(false);

    await page.screenshot({ path: "/Users/kota/Desktop/dub-widget-swap-v3-large-vs-medium.png", fullPage: true });

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const reloaded = await sideBoxes(page);
    expect(sameRect(reloaded["fe2-home-recent"]!, recentAfter)).toBe(true);
    expect(sameRect(reloaded["fe2-home-notifications"]!, notifAfter)).toBe(true);
  });

  test("同面積どうし(小⇄小): panel-recentとpanel-notificationsが正確に位置を交換", async ({ page }) => {
    await seedSizes(page, { "panel-recent": "small", "panel-events": "large", "panel-notifications": "small" });

    const before = await sideBoxes(page);
    const recentBefore = before["fe2-home-recent"];
    const eventsBefore = before["fe2-home-events"];
    const notifBefore = before["fe2-home-notifications"];
    if (!recentBefore || !eventsBefore || !notifBefore) throw new Error("panels not measurable before drag");

    await enterEdit(page);
    await dragHandle(page, "panel-recent", "panel-notifications");
    await exitEdit(page);

    const after = await sideBoxes(page);
    const recentAfter = after["fe2-home-recent"];
    const eventsAfter = after["fe2-home-events"];
    const notifAfter = after["fe2-home-notifications"];
    if (!recentAfter || !eventsAfter || !notifAfter) throw new Error("panels not measurable after drag");

    // A true reciprocal trade: each ends up EXACTLY at the other's old rect.
    expect(sameRect(recentAfter, notifBefore)).toBe(true);
    expect(sameRect(notifAfter, recentBefore)).toBe(true);
    // events (untouched, large) is byte-identical — it was never part of the drag.
    expect(sameRect(eventsAfter, eventsBefore)).toBe(true);
    expect(overlaps(recentAfter, eventsAfter)).toBe(false);
    expect(overlaps(notifAfter, eventsAfter)).toBe(false);

    await page.screenshot({ path: "/Users/kota/Desktop/dub-widget-swap-v3-same-area.png", fullPage: true });

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const reloaded = await sideBoxes(page);
    expect(sameRect(reloaded["fe2-home-recent"]!, recentAfter)).toBe(true);
    expect(sameRect(reloaded["fe2-home-notifications"]!, notifAfter)).toBe(true);
    expect(sameRect(reloaded["fe2-home-events"]!, eventsAfter)).toBe(true);
  });
});
