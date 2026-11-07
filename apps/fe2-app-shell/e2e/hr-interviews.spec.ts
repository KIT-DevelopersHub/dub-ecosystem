// 人事 → 面談タブと公開の日程選択を demo transport の実ブラウザで通す (VITE_DEMO=1)。
import { expect, test } from "@playwright/test";

const shot = (name: string) => `e2e/.output/hr-interviews-${name}.png`;

test("候補が足りない間は保留し、揃うと送信済みになる", async ({ page }) => {
  await page.goto("/hr/interviews");
  await expect(page.getByTestId("fe2-hr-interviews-status-message")).toContainText("保留しています");
  await expect(page.getByTestId("fe2-hr-interviews-open-count")).toHaveText("3");
  await page.screenshot({ path: shot("held"), fullPage: true });

  // 2 週先 (全コマが未来) で、火 9:00 から水 9:30 までをドラッグ = 4 コマ
  await page.getByTestId("fe2-hr-grid-next").click();
  await page.getByTestId("fe2-hr-grid-next").click();
  const from = (await page.getByTestId("fe2-hr-cell-1:0").boundingBox())!;
  const to = (await page.getByTestId("fe2-hr-cell-2:1").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.screenshot({ path: shot("dragging"), fullPage: true });
  await page.mouse.up();
  await expect(page.locator('[data-cell][data-kind="mine"]')).toHaveCount(4);
  await expect(page.getByTestId("fe2-hr-interviews-open-count")).toHaveText("7");
  await expect(page.getByTestId("fe2-hr-interviews-status-message")).toContainText("候補が揃っています");
  await expect(page.getByTestId("fe2-hr-interviews-invite-table")).toContainText("メール送信済み");
  await page.screenshot({ path: shot("released"), fullPage: true });
  await page.getByTestId("fe2-hr-slot-grid").screenshot({ path: shot("grid") });

  // 自分の枠から始めると、まとめて外す
  const mineFrom = (await page.getByTestId("fe2-hr-cell-1:0").boundingBox())!;
  const mineTo = (await page.getByTestId("fe2-hr-cell-1:1").boundingBox())!;
  await page.mouse.move(mineFrom.x + 5, mineFrom.y + 5);
  await page.mouse.down();
  await page.mouse.move(mineTo.x + 5, mineTo.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-cell][data-kind="mine"]')).toHaveCount(2);
});

test("応募者が日程を選ぶと確定し、人事の画面に反映される", async ({ page }) => {
  await page.goto("/interview-book#t=demo");
  const card = page.getByTestId("interview-booking-card");
  await expect(card).toBeVisible();
  await page.screenshot({ path: shot("picker"), fullPage: true });
  await card.getByRole("radio").first().check();
  await page.getByTestId("interview-booking-submit").click();
  await expect(page.getByTestId("interview-booking-done")).toContainText("面談の日程を承りました");
  await page.screenshot({ path: shot("booked"), fullPage: true });
});

test("不正な URL は案内を出す", async ({ page }) => {
  await page.goto("/interview-book#t=wrong");
  await expect(page.getByTestId("interview-booking-invalid")).toBeVisible();
});
