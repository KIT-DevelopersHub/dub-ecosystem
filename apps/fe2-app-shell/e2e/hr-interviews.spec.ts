// 人事 → 面談タブと公開の日程選択を demo transport の実ブラウザで通す (VITE_DEMO=1)。
import { expect, test } from "@playwright/test";

const shot = (name: string) => `e2e/.output/hr-interviews-${name}.png`;

test("候補が足りない間は保留し、揃うと送信済みになる", async ({ page }) => {
  await page.goto("/hr/interviews");
  await page.getByTestId("fe2-hr-interviews-register").screenshot({ path: shot("register") });
  await expect(page.getByTestId("fe2-hr-interviews-status-message")).toContainText("保留しています");
  await expect(page.getByTestId("fe2-hr-interviews-open-count")).toHaveText("3");
  await page.screenshot({ path: shot("held"), fullPage: true });

  // 登録の場所はタブの先頭。7 日後から (全マスが未来) で、2 日 × 9:00〜10:00 をドラッグ = 4 マス
  await expect(page.getByTestId("fe2-hr-interviews-register")).toContainText("面談可能な日程を登録");
  await page.getByTestId("fe2-hr-grid-next").click();
  const from = (await page.getByTestId("fe2-hr-cell-1:0").boundingBox())!;
  const to = (await page.getByTestId("fe2-hr-cell-2:1").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.screenshot({ path: shot("dragging"), fullPage: true });
  await page.mouse.up();
  await expect(page.getByTestId("fe2-hr-grid-selected")).toHaveText("4 マスを選んでいます");
  await page.getByTestId("fe2-hr-slot-grid").screenshot({ path: shot("selected") });
  await page.getByTestId("fe2-hr-grid-commit").click();
  await expect(page.locator('[data-cell][data-kind="mine"]')).toHaveCount(4);
  await expect(page.getByTestId("fe2-hr-interviews-open-count")).toHaveText("7");
  await expect(page.getByTestId("fe2-hr-interviews-status-message")).toContainText("候補が揃っています");
  await expect(page.getByTestId("fe2-hr-interviews-invite-table")).toContainText("メール送信済み");
  await page.screenshot({ path: shot("released"), fullPage: true });
  await page.getByTestId("fe2-hr-slot-grid").screenshot({ path: shot("grid") });

  // 登録済み (自分) を選ぶと「登録を外す」になる
  await page.getByTestId("fe2-hr-cell-1:0").evaluate((el) => el.scrollIntoView({ block: "center" }));
  const mineFrom = (await page.getByTestId("fe2-hr-cell-1:0").boundingBox())!;
  const mineTo = (await page.getByTestId("fe2-hr-cell-1:1").boundingBox())!;
  await page.mouse.move(mineFrom.x + mineFrom.width / 2, mineFrom.y + mineFrom.height / 2);
  await page.mouse.down();
  await page.mouse.move(mineTo.x + mineTo.width / 2, mineTo.y + mineTo.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("fe2-hr-grid-commit")).toHaveText("登録を外す");
  await page.getByTestId("fe2-hr-grid-commit").click();
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
