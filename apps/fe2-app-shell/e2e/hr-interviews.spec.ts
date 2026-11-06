// 人事 → 面談タブと公開の日程選択を demo transport の実ブラウザで通す (VITE_DEMO=1)。
import { expect, test } from "@playwright/test";

const shot = (name: string) => `e2e/.output/hr-interviews-${name}.png`;

test("候補が足りない間は保留し、揃うと送信済みになる", async ({ page }) => {
  await page.goto("/hr/interviews");
  await expect(page.getByTestId("fe2-hr-interviews-status-message")).toContainText("保留しています");
  await expect(page.getByTestId("fe2-hr-interviews-open-count")).toHaveText("3");
  await page.screenshot({ path: shot("held"), fullPage: true });

  for (const day of ["2031-03-03T10:00", "2031-03-04T10:00"]) {
    await page.getByTestId("fe2-hr-slot-start").fill(day);
    await page.getByTestId("fe2-hr-slot-add").click();
  }
  await expect(page.getByTestId("fe2-hr-interviews-status-message")).toContainText("候補が揃っています");
  await expect(page.getByTestId("fe2-hr-interviews-invite-table")).toContainText("メール送信済み");
  await page.screenshot({ path: shot("released"), fullPage: true });
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
