// ①⌘Kグローバル検索 (cross-service content search) E2E — real browser, DEMO transport.
// Proves the extension on top of the existing app/action palette (P06):
//   (1) Ctrl+K opens the palette from anywhere;
//   (2) a task-title query surfaces a グループ "タスク" result and Enter opens the
//       task's detail panel (deep-linked via /events/:eventId/tasks/:taskId);
//   (3) an event-title query surfaces a グループ "イベント" result and Enter opens
//       the event;
//   (4) Esc closes the palette.
// Screenshots land in ~/DubVault/docs/cmdk-global-search/.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "cmdk-global-search");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const PALETTE = "fe2-cmdk";
const INPUT = "fe2-cmdk-input";

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId(PALETTE)).toBeVisible();
}

test("⌘K search: task result opens the task detail, event result opens the event, Esc closes", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();

  // (1) Opens from the home screen and focuses the input.
  await openPalette(page);
  await expect(page.getByTestId(INPUT)).toBeFocused();
  await page.screenshot({ path: shot("01-open.png") });

  // (2) Task search — demo-seeded "登壇者スケジュール確定" (tsk_1, assigned to the demo
  // user) — surfaces under a "タスク" group ahead of any app matches.
  await page.getByTestId(INPUT).fill("登壇者");
  const taskItem = page.getByTestId("fe2-cmdk-item-content-task-tsk-1");
  await expect(taskItem).toBeVisible();
  await expect(page.getByText("タスク", { exact: true })).toBeVisible();
  await page.screenshot({ path: shot("02-task-results.png") });

  await taskItem.click();
  await expect(page.getByTestId(PALETTE)).toBeHidden();
  await expect(page).toHaveURL(/\/events\/evt_1\/tasks\/tsk_1$/);
  // Deep-link auto-opens the task's detail panel (not just the bare workspace).
  await expect(page.getByTestId("fe4-detail-panel")).toBeVisible();
  await expect(page.getByTestId("fe4-detail-title")).toHaveValue("登壇者スケジュール確定");
  await page.screenshot({ path: shot("03-task-opened.png") });

  // (3) Event search — demo-seeded "北陸ITカンファレンス 2026" (evt_1) — surfaces
  // under a "イベント" group and Enter (keyboard) navigates to the event page.
  await openPalette(page);
  await page.getByTestId(INPUT).fill("北陸");
  const eventItem = page.getByTestId("fe2-cmdk-item-content-event-evt-1");
  await expect(eventItem).toBeVisible();
  await page.screenshot({ path: shot("04-event-results.png") });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(PALETTE)).toBeHidden();
  await expect(page).toHaveURL(/\/events\/evt_1$/);
  await page.screenshot({ path: shot("05-event-opened.png") });

  // (4) Esc closes without navigating.
  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(PALETTE)).toBeHidden();
});
