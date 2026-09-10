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
