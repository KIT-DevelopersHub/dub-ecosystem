// Home dashboard 編集モード (P3-3) E2E — real browser, DEMO transport (VITE_DEMO=1:
// auto-login + seeded data, no gateway). Proves what a unit test (jsdom, no real
// layout) cannot: pointer drag-and-drop actually reorders KPI tiles, the SAME
// reorder works from the keyboard alone, and the new order survives a reload
// (P3-2's persistence, now driven by the P3-3 inline edit UI instead of a modal).
// Kept short and focused — one flow, no polling loops — per the "avoid long E2E /
// infinite waits" constraint for this task.
import { test, expect, type Page } from "@playwright/test";

/** Ordered KPI catalog ids ("kpi-countdown", ...) currently rendered in the KPI
 *  row — normalized so the SAME ids compare across edit-mode states: outside
 *  editing each tile's own testid is the direct child ("fe2-kpi-countdown"); while
 *  editing, SortableList adds a wrapper div per row, so the id sits one level down
 *  on the `fe2-widget-edit-<catalogId>` chrome div instead. */
async function kpiOrder(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="fe2-home-kpis"]');
    if (!row) return [];
    return Array.from(row.children).map((child) => {
      const testId = child.getAttribute("data-testid") ?? child.firstElementChild?.getAttribute("data-testid") ?? null;
      if (!testId) return null;
      if (testId.startsWith("fe2-widget-edit-")) return testId.slice("fe2-widget-edit-".length);
      if (testId.startsWith("fe2-")) return testId.slice("fe2-".length);
      return testId;
    });
  });
}

test("編集モード: pointer drag, keyboard reorder, and persistence across reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-kpi-members")).toBeVisible();

  const before = await kpiOrder(page);
  expect(before[0]).toBe("kpi-countdown"); // default catalog order

  // ── enter 編集モード ─────────────────────────────────────────────────────────
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "true");
  const firstHandle = page.getByTestId("fe2-widget-handle-kpi-countdown");
  await expect(firstHandle).toBeVisible();

  // ── pointer drag: drag the first KPI tile's handle onto the second tile ────
  const fromBox = await firstHandle.boundingBox();
  const toBox = await page.getByTestId("fe2-widget-handle-kpi-tasks").boundingBox();
  if (!fromBox || !toBox) throw new Error("drag handles not measurable");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 20, fromBox.y + fromBox.height / 2, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await page.mouse.up();

  const afterDrag = await kpiOrder(page);
  expect(afterDrag[0]).toBe("kpi-tasks"); // タスク完了率 tile moved to the front
  expect(afterDrag).not.toEqual(before);

  // ── keyboard reorder: Space picks up the handle, an arrow key moves it, Space
  // drops it — no mouse involved, proving the same primitive is keyboard-operable. ──
  const handle = page.getByTestId("fe2-widget-handle-kpi-members");
  await handle.focus();
  await page.keyboard.press("Space"); // pick up
  await page.waitForTimeout(100); // let dnd-kit's onDragStart settle before the arrow moves it
  await page.keyboard.press("ArrowLeft"); // KPI tiles sit in one grid ROW — Left/Right move within it
  await page.waitForTimeout(100);
  await page.keyboard.press("Space"); // drop
  await page.waitForTimeout(100);
  const afterKeyboard = await kpiOrder(page);
  expect(afterKeyboard).not.toEqual(afterDrag); // 運営メンバー moved via keyboard alone

  // ── 完了 exits edit mode; the order just set is what's live ────────────────
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");
  const liveOrder = await kpiOrder(page);
  expect(liveOrder).toEqual(afterKeyboard);

  // ── persistence: reload and the SAME order (P3-2's storage, P3-3's UI) holds ──
  await page.reload();
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-kpi-members")).toBeVisible();
  const reloadedOrder = await kpiOrder(page);
  expect(reloadedOrder).toEqual(liveOrder);
});

// P3-4: iOS 風 3 サイズ (small/medium/large) — a tile can be resized, mixed sizes
// reorder together in the same grid, and the choice persists across reload.
test("編集モード: resize a tile to 大, mix sizes while reordering, and persist across reload", async ({ page }) => {
  // The 編集モード jiggle (a continuous rotate animation on every tile, like iOS) keeps
  // Playwright's `.click()` actionability check from ever seeing the size-picker
  // buttons as "stable" — reduced-motion is exactly the escape hatch the CSS already
  // wires up (`@media (prefers-reduced-motion: reduce)` drops the jiggle), and the
  // pointer-drag test above deliberately drives raw mouse events instead, so this is
  // the only spec that needs it.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-kpi-members")).toBeVisible();

  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "true");

  // Every KPI tile starts 小 (small) — the size picker is present per-widget.
  await expect(page.getByTestId("fe2-widget-size-kpi-countdown-small")).toHaveAttribute("aria-selected", "true");

  // Switch the first tile to 大 (large) — its span grows to a 2x2 block.
  await page.getByTestId("fe2-widget-size-kpi-countdown-large").click();
  await expect(page.getByTestId("fe2-widget-size-kpi-countdown-large")).toHaveAttribute("aria-selected", "true");
  // `grid-row: span 2` (a single-value shorthand) sets grid-row-START to "span 2" and
  // leaves grid-row-end at its "auto" default — the span itself lives on the start
  // property's computed value. It's set on the SortableList ROW (getItemStyle) — the
  // actual CSS Grid item — which is the parent of the `fe2-widget-edit-*` chrome div.
  const largeStyle = await page
    .getByTestId("fe2-widget-edit-kpi-countdown")
    .evaluate((el) => getComputedStyle(el.parentElement!).gridRowStart);
  expect(largeStyle).toContain("span 2");

  // Reorder still works with mixed sizes in play (drag the now-大 tile past its neighbour).
  // Measure the WHOLE tile (not the small drag-handle icon) for the overlay-size check below.
  const fromTileBox = await page.getByTestId("fe2-widget-edit-kpi-countdown").boundingBox();
  const fromHandle = page.getByTestId("fe2-widget-handle-kpi-countdown");
  const toHandle = page.getByTestId("fe2-widget-handle-kpi-tasks");
  const fromBox = await fromHandle.boundingBox();
  const toBox = await toHandle.boundingBox();
  if (!fromBox || !toBox || !fromTileBox) throw new Error("drag handles/tile not measurable");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  // While dragging, the floating overlay clone is sized to match the WHOLE source tile
  // (regression guard for "the lifted tile looks like a different size/shape") — not
  // just the small handle icon that started the drag.
  await page.mouse.move(fromBox.x + fromBox.width / 2 + 30, fromBox.y + fromBox.height / 2 + 10, { steps: 5 });
  const overlay = page.getByTestId("fe2-home-kpis-overlay");
  await expect(overlay).toBeVisible();
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
  expect(Math.abs((overlayBox?.width ?? 0) - fromTileBox.width)).toBeLessThan(4);
  expect(Math.abs((overlayBox?.height ?? 0) - fromTileBox.height)).toBeLessThan(4);
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await page.mouse.up();
  // Let the drop settle (SortableList's drop animation) before the next click — a
  // click mid-animation lands fine functionally, but waiting keeps this deterministic.
  await page.waitForTimeout(350);

  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");

  // Persists: reload and the tile is still 大.
  await page.reload();
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await page.getByTestId("fe2-home-edit-toggle").click();
  await expect(page.getByTestId("fe2-widget-size-kpi-countdown-large")).toHaveAttribute("aria-selected", "true");
});
