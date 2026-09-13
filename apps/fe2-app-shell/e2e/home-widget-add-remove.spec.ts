// Home dashboard widget ADD/REMOVE — real browser, DEMO transport, REAL CLICKS.
// Builds on the real cell grid from home-widget-grid-layout.spec.ts (placement/
// resize): here the ask is "add/remove a widget from the grid", edit-mode only,
// persisted across reload — verified with a real Playwright browser (not
// jsdom), per the repo's real-browser-E2E requirement for UI changes.
import { test, expect, type Page } from "@playwright/test";

async function disableTransitions(page: Page): Promise<void> {
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
}

/** Enter edit mode via the toolbar toggle (normal/static is the default on
 *  every fresh load — add/remove are only reachable after this). */
async function enterEditMode(page: Page): Promise<void> {
  const toggle = page.getByTestId("fe2-home-widget-grid-edit-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

test.describe("Home widget grid: add / remove a widget", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid")).toBeVisible();
    await enterEditMode(page);
    await disableTransitions(page);
  });

  test("normal mode shows no remove button and no add-menu trigger", async ({ page }) => {
    // Return to normal (完了) — remove/add UI is edit-mode only.
    await page.getByTestId("fe2-home-widget-grid-edit-toggle").click();
    await expect(page.getByTestId("fe2-widget-grid-remove-usage")).toHaveCount(0);
    await expect(page.getByTestId("fe2-widget-grid-add-trigger")).toHaveCount(0);
  });

  test("× removes a widget from the grid; 追加 menu offers it back and re-adding restores it", async ({ page }) => {
    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toBeVisible();

    await page.getByTestId("fe2-widget-grid-remove-notifications").click();
    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toHaveCount(0);

    // The 追加 menu now offers exactly the removed widget.
    await page.getByTestId("fe2-widget-grid-add-trigger").click();
    await expect(page.getByTestId("fe2-widget-grid-add-item-notifications")).toBeVisible();
    await page.getByTestId("fe2-widget-grid-add-item-notifications").click();

    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toBeVisible();
  });

  test("追加 menu shows an empty state once every removable widget has been re-added", async ({ page }) => {
    await page.getByTestId("fe2-widget-grid-remove-notifications").click();
    await page.getByTestId("fe2-widget-grid-add-trigger").click();
    await page.getByTestId("fe2-widget-grid-add-item-notifications").click();

    await page.getByTestId("fe2-widget-grid-add-trigger").click();
    await expect(page.getByTestId("fe2-widget-grid-add-empty")).toBeVisible();
    await expect(page.getByTestId("fe2-widget-grid-add-empty")).toHaveText("追加できるウィジェットはありません");
  });

  test("removal survives reload (persisted, not just in-memory state)", async ({ page }) => {
    await page.getByTestId("fe2-widget-grid-remove-notifications").click();
    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid")).toBeVisible();

    // Still gone after reload — edit-mode preference also persists (beforeEach
    // entered it), so this is still in edit mode, just with "notifications" absent.
    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toHaveCount(0);

    // ...and re-adding it also survives a reload.
    await page.getByTestId("fe2-widget-grid-add-trigger").click();
    await page.getByTestId("fe2-widget-grid-add-item-notifications").click();
    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("fe2-home")).toBeVisible();
    await expect(page.getByTestId("fe2-widget-grid-item-notifications")).toBeVisible();
  });

  test("removing every widget shows the empty-state prompt but the toolbar (add menu, edit toggle) stays reachable", async ({
    page,
  }) => {
    const ids = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="fe2-widget-grid-item-"]')).map((el) =>
        (el.getAttribute("data-testid") ?? "").replace("fe2-widget-grid-item-", ""),
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      await page.getByTestId(`fe2-widget-grid-remove-${id}`).click();
    }

    await expect(page.getByTestId("fe2-home-widget-grid-empty")).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid-edit-toggle")).toBeVisible();
    await expect(page.getByTestId("fe2-widget-grid-add-trigger")).toBeVisible();

    // Recoverable: add the first one back from the (now non-empty) 追加 menu.
    await page.getByTestId("fe2-widget-grid-add-trigger").click();
    await page.getByTestId(`fe2-widget-grid-add-item-${ids[0]}`).click();
    await expect(page.getByTestId(`fe2-widget-grid-item-${ids[0]}`)).toBeVisible();
    await expect(page.getByTestId("fe2-home-widget-grid-empty")).toHaveCount(0);
  });
});
