// Real-browser verification for マイタスク quick status change (DEMO transport).
// #880 replaced the P11 list checkbox with the kanban: 「移動」 → 完了 moves the card
// to the 完了 column at once (optimistic). Screenshots land in ~/DubVault/docs/delight-ux-p11/.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "delight-ux-p11");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test.describe("マイタスク kanban — move a card to 完了", () => {
  test("「移動」→ 完了 moves the card to the 完了 column", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/me/tasks");
    await expect(page.getByTestId("fe4-task-view-tabs-tab-kanban")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("fe4-mytasks-kanban")).toBeVisible();

    // tsk_2 (会場レイアウト図作成) is seeded todo/ME_ID — movable.
    const card = page.getByTestId("fe4-kanban-card-tsk_2");
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute("data-editable", "true");
    await page.screenshot({ path: shot("kanban-01-before.png") });

    await page.getByTestId("fe4-kanban-move-tsk_2-trigger").click();
    await page.getByTestId("fe4-kanban-move-tsk_2-done").click();
    await expect(page.getByTestId("fe4-kanban-column-done").getByTestId("fe4-kanban-card-tsk_2")).toBeVisible();
    await page.screenshot({ path: shot("kanban-02-done.png") });
  });
});
