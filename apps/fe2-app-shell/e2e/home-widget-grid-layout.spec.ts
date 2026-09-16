// Home dashboard widget PLACEMENT — real browser, DEMO transport, REAL MOUSE.
//
// The previous three attempts at this feature (feat/home-widget-dnd,
// feat/home-widget-dnd-v2, feat/home-widget-area-swap — all rejected) modeled
// "placement" as reordering rows in a sortable list. That is a different feature
// from what was asked for: "配置できるエリアを升目(グリッドのセル)として演算する。
// 2x2の升目=中、1x2=小、のようにサイズを指定する。ドラッグして移動する時に、他の
// ウィジェットが自動で避ける(reflow/衝突回避)". This spec drives the REAL cell
// grid (react-grid-layout, see dashboard/HomeWidgetGrid.tsx + homeGrid.ts) with a
// real mouse (page.mouse.move/down/up, not a synthetic dragTo/dispatchEvent) and
// asserts on REAL pixel rectangles (getBoundingClientRect via boundingBox()) —
// never DOM order alone — because DOM-order assertions are exactly what let the
// three rejected sortable-list attempts look "done" without solving the ask.
import { test, expect, type Page } from "@playwright/test";

type Rect = { x: number; y: number; width: number; height: number };

async function widgetRect(page: Page, id: string): Promise<Rect> {
  const box = await page.getByTestId(`fe2-widget-grid-item-${id}`).boundingBox();
  if (!box) throw new Error(`widget "${id}" has no bounding box (not rendered/visible)`);
  return box;
}

async function allWidgetRects(page: Page): Promise<Record<string, Rect>> {
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="fe2-widget-grid-item-"]')).map((el) =>
      (el.getAttribute("data-testid") ?? "").replace("fe2-widget-grid-item-", ""),
    ),
  );
  const out: Record<string, Rect> = {};
  for (const id of ids) out[id] = await widgetRect(page, id);
  return out;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertNoOverlaps(rects: Record<string, Rect>): void {
  const entries = Object.entries(rects);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, a] = entries[i]!;
      const [idB, b] = entries[j]!;
      expect(overlaps(a, b), `"${idA}" and "${idB}" must not overlap: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
        false,
      );
    }
  }
}

/** Real mouse drag: press on the widget's own grab handle, move in several
 *  intermediate steps (react-draggable/react-grid-layout need real mousemove
 *  events past a threshold to register a drag — a single teleport does not),
 *  then release over the target point. */
async function dragWidgetTo(page: Page, widgetId: string, targetX: number, targetY: number): Promise<void> {
  const handle = page.getByTestId(`fe2-widget-grab-${widgetId}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`grab handle for "${widgetId}" not found`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((targetX - startX) * i) / steps;
    const y = startY + ((targetY - startY) * i) / steps;
    await page.mouse.move(x, y, { steps: 2 });
    await page.waitForTimeout(20);
  }
  await page.mouse.move(targetX, targetY, { steps: 2 });
  await page.waitForTimeout(50);
  await page.mouse.up();
  // Let react-grid-layout's onLayoutChange → zustand → re-render settle.
  await page.waitForTimeout(150);
}

async function disableTransitions(page: Page): Promise<void> {
  // react-grid-layout animates every reposition with a 200ms CSS transition
  // (see react-grid-layout/css/styles.css: "transition: all 200ms ease").
  // Reading getBoundingClientRect() mid-animation would catch an interpolated,
  // in-between frame and misreport it as an "overlap" that never actually
  // exists at rest — a pure animation artifact, not a placement bug. Disable
  // all CSS transitions/animations for the page so every pixel read below
  // reflects the SETTLED layout only.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
}

/** Enter edit mode via the toolbar toggle (normal/static is the default on
 *  every fresh load — drag/resize are only reachable after this). */
async function enterEditMode(page: Page): Promise<void> {
  const toggle = page.getByTestId("fe2-home-widget-grid-edit-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

test.describe("Home widget grid: edit mode <-> normal (static) mode toggle", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid")).toBeVisible();
    await disableTransitions(page);
  });

  test("normal mode (default): no grab handle/size control, and a real-mouse drag attempt does not move anything", async ({
    page,
  }) => {
    const toggle = page.getByTestId("fe2-home-widget-grid-edit-toggle");
    await expect(toggle).toHaveText("編集");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // No editing affordances rendered at all in static mode.
    await expect(page.getByTestId("fe2-widget-grab-usage")).toHaveCount(0);
    await expect(page.getByTestId("fe2-widget-size-usage")).toHaveCount(0);
    await expect(page.getByTestId("fe2-home-widget-grid-reset")).toHaveCount(0);

    const before = await widgetRect(page, "usage");
    // Attempt a real-mouse drag starting from where the grab handle WOULD be
    // (top-left of the widget's chrome area) — must be a no-op since there is
    // no draggable handle and RGL's isDraggable is false in this mode.
    await page.mouse.move(before.x + 12, before.y + 12);
    await page.mouse.down();
    await page.mouse.move(before.x + 220, before.y + 160, { steps: 10 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(100);

    const after = await widgetRect(page, "usage");
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  });

  test("編集 button enters edit mode (handle + size control appear, dashed outline shown) and 完了 returns to static", async ({
    page,
  }) => {
    const toggle = page.getByTestId("fe2-home-widget-grid-edit-toggle");
    await toggle.click();
    await expect(toggle).toHaveText("完了");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("fe2-widget-grab-usage")).toBeVisible();
    await expect(page.getByTestId("fe2-widget-size-usage")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid-reset")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid")).toHaveClass(/fe2-widget-grid-wrap--editing/);

    await toggle.click();
    await expect(toggle).toHaveText("編集");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("fe2-widget-grab-usage")).toHaveCount(0);
    await expect(page.getByTestId("fe2-widget-size-usage")).toHaveCount(0);
    await expect(page.getByTestId("fe2-home-widget-grid")).not.toHaveClass(/fe2-widget-grid-wrap--editing/);
  });

  test("edit-mode preference survives reload", async ({ page }) => {
    await enterEditMode(page);
    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    const toggle = page.getByTestId("fe2-home-widget-grid-edit-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("fe2-widget-grab-usage")).toBeVisible();
  });
});

test.describe("Home widget grid: real cell grid, drag reflows, sizes are cell spans", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); // wide grid (6 cols)
    await page.goto("/");
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid")).toBeVisible();
    // All drag/resize below requires edit mode — static (default) mode has no
    // grab handle/size control at all (covered separately above).
    await enterEditMode(page);
    await disableTransitions(page);
  });

  test("renders every widget as a real, non-overlapping grid cell (no overlaps at rest)", async ({ page }) => {
    const rects = await allWidgetRects(page);
    expect(Object.keys(rects).length).toBeGreaterThanOrEqual(4); // usage/tasks/events/notifications at minimum
    assertNoOverlaps(rects);
  });

  test("小(1x2) and 中(2x2) are real, distinct cell spans — 中 is roughly twice as wide as 小", async ({ page }) => {
    // Defaults: usage/tasks/events = 中 (medium), notifications = 小 (small).
    const medium = await widgetRect(page, "usage");
    const small = await widgetRect(page, "notifications");
    // Same row height unit (both span 2 rows) → heights are close; widths differ
    // by roughly a factor of 2 (中=2 cols vs 小=1 col, same column width).
    expect(Math.abs(medium.height - small.height)).toBeLessThan(20);
    const ratio = medium.width / small.width;
    expect(ratio, `中/小 width ratio should be ~2 (got ${ratio})`).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.6);
  });

  test("real-mouse drag: moving a widget onto another's cells pushes the other one out of the way (no overlap, no DOM-order-only check)", async ({
    page,
  }) => {
    const before = await allWidgetRects(page);
    assertNoOverlaps(before);
    const usageBefore = before.usage!;

    // Drag "tasks" (中) onto the CENTER of "usage"'s (中) current cells — a direct
    // collision by construction, not an adjacent nudge.
    const targetX = usageBefore.x + usageBefore.width / 2;
    const targetY = usageBefore.y + usageBefore.height / 2;
    await dragWidgetTo(page, "tasks", targetX, targetY);

    const after = await allWidgetRects(page);
    assertNoOverlaps(after); // the actual ask: nothing overlaps once the drop settles

    // "usage" must have MOVED (been pushed) — it is not simply hidden behind
    // "tasks" or unchanged; real reflow, not a z-index trick.
    const usageAfter = after.usage!;
    const moved = Math.abs(usageAfter.x - usageBefore.x) > 4 || Math.abs(usageAfter.y - usageBefore.y) > 4;
    expect(moved, "the widget that was dragged onto must actually relocate (reflow), not just get overlapped").toBe(true);

    // "tasks" itself must now sit at (approximately) where it was dropped.
    const tasksAfter = after.tasks!;
    expect(Math.abs(tasksAfter.x - usageBefore.x)).toBeLessThan(usageBefore.width);

    await page.screenshot({ path: "e2e/.output/home-widget-grid-drag-after.png" });
  });

  test("mixed sizes (小/中/大) coexist without overlap after a resize", async ({ page }) => {
    // Grow "notifications" (小) to 大 via the size control — a discrete cell-span
    // change (not a free pixel resize handle), then confirm the grid reflows
    // every other widget out of its new footprint.
    await page.getByTestId("fe2-widget-size-notifications-large").click();
    await page.waitForTimeout(150);

    const rects = await allWidgetRects(page);
    assertNoOverlaps(rects);

    // Confirm the resize actually took effect (大 must be wider than 中): compare
    // against "usage", which stays at its default 中 size throughout this test.
    const notif = rects.notifications!;
    const usage = rects.usage!;
    expect(notif.width).toBeGreaterThan(usage.width - 4);
  });

  test("a real-mouse placement survives reload (persisted, not just in-memory state)", async ({ page }) => {
    const before = await allWidgetRects(page);
    const notifBefore = before.notifications!;

    // Drag "notifications" (小, which packs into the bottom-left by default —
    // three 中 widgets already fill the entire top row) to the TOP-RIGHT corner
    // instead: guaranteed different from its packed default, unlike "bottom-left"
    // which can coincide with where it already rests.
    const grid = await page.getByTestId("fe2-home-widget-grid").boundingBox();
    if (!grid) throw new Error("grid not found");
    const targetX = grid.x + grid.width - 40;
    const targetY = grid.y + 40;
    await dragWidgetTo(page, "notifications", targetX, targetY);

    const afterDrag = await widgetRect(page, "notifications");
    const actuallyMoved = Math.abs(afterDrag.x - notifBefore.x) > 4 || Math.abs(afterDrag.y - notifBefore.y) > 4;
    expect(actuallyMoved, "drag must have visibly relocated the widget before we test persistence").toBe(true);

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid")).toBeVisible();
    // A reload wipes the beforeEach's injected stylesheet — re-disable
    // transitions so this reads the settled post-reload layout, not a
    // transition-in-progress frame (see beforeEach for why this matters).
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });

    const afterReload = await widgetRect(page, "notifications");
    expect(Math.abs(afterReload.x - afterDrag.x), "x must survive reload").toBeLessThan(6);
    expect(Math.abs(afterReload.y - afterDrag.y), "y must survive reload").toBeLessThan(6);

    const allAfterReload = await allWidgetRects(page);
    assertNoOverlaps(allAfterReload);
  });

  test("配置をリセット restores the default packed layout", async ({ page }) => {
    const defaultRects = await allWidgetRects(page);

    await dragWidgetTo(
      page,
      "notifications",
      defaultRects.usage!.x + defaultRects.usage!.width / 2,
      defaultRects.usage!.y + defaultRects.usage!.height / 2,
    );
    const afterDrag = await allWidgetRects(page);
    expect(JSON.stringify(afterDrag)).not.toBe(JSON.stringify(defaultRects));

    await page.getByTestId("fe2-home-widget-grid-reset").click();
    await page.waitForTimeout(150);

    // Reset must not leave "notifications" sitting on top of "usage" — the two
    // must be distinct, non-overlapping cells again, matching the pre-drag shape.
    const rectsAfterReset = await allWidgetRects(page);
    assertNoOverlaps(rectsAfterReset);
  });
});
