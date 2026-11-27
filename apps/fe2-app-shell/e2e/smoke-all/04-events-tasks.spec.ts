// イベント → アクション、ガント、マイタスク。
import { enter, expect, expectNoErrorScreen, test } from "./_support.ts";

test("イベント一覧 → イベント → アクションを開く", async ({ page, shot }) => {
  await enter(page, "/events/list");
  await expect(page.getByTestId("fe3-eventlist")).toBeVisible();
  const card = page.locator('[data-testid^="fe3-eventlist-card-"]').first();
  await expect(card).toBeVisible();
  await shot("04-event-list");
  await card.click();
  await expect(page.getByTestId("fe3-detail")).toBeVisible();
  await expect(page.getByTestId("fe3-actionboard")).toBeVisible();
  await shot("04-event-detail");

  const action = page.locator('[data-testid^="fe3-actionboard-card-"]').first();
  await expect(action).toBeVisible();
  // 開けるのは行の中の題名ボタン（行全体ではない）。
  await action.getByRole("button").first().click();
  await expect(page.getByTestId("fe3-action-detail")).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("04-action");
});

test("ガント: 一覧 → イベントのガント", async ({ page, shot }) => {
  await enter(page, "/gantt");
  await expect(page.getByTestId("fe2-gantt-landing")).toBeVisible();
  const open = page.locator('[data-testid^="fe2-gantt-open-"]').first();
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.getByTestId("fe4-gantt-view")).toBeVisible();
  await expect(page.locator('[data-testid^="fe4-gantt-row-title-"]').first()).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("04-gantt");
});

test("マイタスク: 一覧 → 詳細", async ({ page, shot }) => {
  await enter(page, "/me/tasks");
  await expect(page.getByTestId("fe4-me-tasks")).toBeVisible();
  const row = page.locator('[data-testid^="fe4-mytask-row-"]').first();
  await expect(row).toBeVisible();
  await shot("04-mytasks");
  await row.click();
  await expect(page.locator('[role="dialog"], [data-testid*="task-detail"]').first()).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("04-mytask-detail");
});
