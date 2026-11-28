// 人事・目標管理（表示の確認のみ）。
import { enter, expect, expectNoErrorScreen, test } from "./_support.ts";

test("人事: 応募者 → 申し込みフォーム → 参加届", async ({ page, shot }) => {
  await enter(page, "/hr");
  await expect(page.getByTestId("fe2-hr-applicants-screen")).toBeVisible();
  // 応募者が 0 人の環境では表の代わりに空の案内が出る。
  await expect(page.getByTestId("fe2-hr-table").or(page.getByTestId("fe2-hr-empty")).first()).toBeVisible();
  await shot("05-hr-applicants");
  await page.getByTestId("fe2-hr-tabs-tab-form").click();
  await expectNoErrorScreen(page);
  await shot("05-hr-form");
  await page.getByTestId("fe2-hr-tabs-tab-participation").click();
  await expectNoErrorScreen(page);
  await shot("05-hr-participation");
});

test("目標管理: チームの目標が並ぶ", async ({ page, shot }) => {
  await enter(page, "/goals");
  await expect(page.getByTestId("fe2-goals-screen")).toBeVisible();
  await expect(page.locator('[data-testid^="fe2-goals-team-"]').first()).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("05-goals");
});
