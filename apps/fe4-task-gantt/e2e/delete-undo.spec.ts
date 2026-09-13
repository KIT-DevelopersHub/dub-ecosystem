// Real-browser proof of the gantt delete-undo feature against the mock-backed demo:
//   1. delete a task from the detail panel (its row disappears),
//   2. Ctrl-Z opens a ConfirmDialog instead of restoring silently,
//   3. [キャンセル] keeps it deleted,
//   4. Ctrl-Z then [戻す] restores the task (server-reflected via the mock).
// Screenshots are written to e2e/.output.
import { test, expect } from "@playwright/test";

test("delete → Ctrl-Z → confirm dialog → 戻す restores the task", async ({ page }) => {
  await page.goto("/");

  // The demo opens on マイタスク; switch to the ガント workspace.
  await page.getByTestId("demo-tab-gantt").click();
  await expect(page.getByTestId("fe4-gantt-view")).toBeVisible();

  // Pick the first task row (id-agnostic — the demo uses WBS-derived ids).
  const firstRow = page.locator('[data-testid^="fe4-gantt-row-"]').first();
  await expect(firstRow).toBeVisible();
  const rowTestId = await firstRow.getAttribute("data-testid");
  expect(rowTestId).toBeTruthy();
  const row = page.getByTestId(rowTestId!);
  await firstRow.click();

  // Delete it via the detail panel's confirm-delete.
  const panel = page.getByTestId("fe4-detail-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("fe4-detail-delete").click();
  await panel.getByTestId("fe4-confirm-yes").click();
  await expect(row).toHaveCount(0);
  await page.screenshot({ path: "e2e/.output/01-deleted.png", fullPage: true });

  // Ctrl-Z opens the confirm dialog (the hotkey listens for metaKey||ctrlKey, so
  // Control works cross-platform in Chromium) — it does NOT restore silently.
  await page.keyboard.press("Control+z");
  const dialog = page.getByTestId("fe4-undo-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/復元します/)).toBeVisible();
  await expect(row).toHaveCount(0); // still deleted while confirming
  await page.screenshot({ path: "e2e/.output/02-confirm-dialog.png", fullPage: true });

  // [キャンセル] closes the dialog and leaves the task deleted.
  await dialog.getByText("キャンセル").click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);

  // Ctrl-Z again, then [戻す] restores the task — the row comes back after the reconcile.
  await page.keyboard.press("Control+z");
  await expect(dialog).toBeVisible();
  await dialog.getByText("戻す").click();
  await expect(row).toBeVisible();
  await page.screenshot({ path: "e2e/.output/03-restored.png", fullPage: true });
});
