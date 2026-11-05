// 「ロールとの差分」 E2E (real browser, DEMO transport / mock Drive). The demo seeds the
// maintainer role as 編集 on Hackit 2026 共有 while Drive has drifted from it: staff-a (no
// role) still has 編集, araki was lowered to 閲覧, ikeda (名簿 Gmail) and ryoma (no Gmail) were
// never shared. The card lists exactly those, and fixing them in the UI updates the drift.
import { test, expect } from "@playwright/test";

test("drift card lists shares that differ from the role grants and follows a fix", async ({ page }) => {
  await page.goto("/driveshare");
  await page.getByTestId("fe2-driveshare-search").fill("Hackit 2026");
  await page.getByTestId("fe2-driveshare-file").filter({ hasText: "Hackit 2026 共有" }).click();

  const card = page.getByTestId("fe2-driveshare-drift");
  await expect(card.getByTestId("fe2-driveshare-drift-badge")).toHaveText("差分 4件");
  await expect(card.getByTestId("fe2-driveshare-drift-unexpected")).toContainText("staff-a@example.com");
  await expect(card.getByTestId("fe2-driveshare-drift-insufficient_role")).toContainText("araki@developershub.jp");
  await expect(card.getByTestId("fe2-driveshare-drift-insufficient_role")).toContainText("閲覧者（ロール「maintainer」では編集者）");
  // Members are expected at their 名簿 Gmail, not the login address.
  await expect(card.getByTestId("fe2-driveshare-drift-missing")).toContainText("ikeda.h@gmail.com");
  await expect(card.getByTestId("fe2-driveshare-drift-missing")).toContainText("ryoma@developershub.jp");
  await card.screenshot({ path: test.info().outputPath("01-drift.png") });

  // Revoke the out-of-role share from the permission list → the drift refreshes.
  const staffRow = page.getByTestId("fe2-driveshare-permission").filter({ hasText: "staff-a@example.com" });
  await staffRow.getByTestId("fe2-driveshare-revoke").click();
  await page.getByRole("button", { name: "剥奪する" }).click();
  await expect(card.getByTestId("fe2-driveshare-drift-badge")).toHaveText("差分 3件");
  await expect(card.getByTestId("fe2-driveshare-drift-unexpected")).toHaveCount(0);

  // Re-applying shares ikeda at the Gmail; ryoma (no Gmail) is skipped with how to fix it.
  await page.getByTestId("fe2-driveshare-role-grant-reapply").click();
  await expect(page.getByText(/名簿にこのメンバーの Gmail を登録/)).toBeVisible();
  await expect(card.getByTestId("fe2-driveshare-drift-badge")).toHaveText("差分 1件");
  await expect(card.getByTestId("fe2-driveshare-drift-missing")).toContainText("ryoma@developershub.jp");
  await expect(card.getByTestId("fe2-driveshare-drift-missing")).not.toContainText("ikeda");
  await expect(page.getByTestId("fe2-driveshare-permission").filter({ hasText: "ikeda.h@gmail.com" })).toBeVisible();
  await card.screenshot({ path: test.info().outputPath("02-clean.png") });

  // A file without any role grant has nothing to compare with.
  await page.getByTestId("fe2-driveshare-search").fill("予算管理");
  await page.getByTestId("fe2-driveshare-file").filter({ hasText: "予算管理" }).click();
  await expect(card.getByTestId("fe2-driveshare-drift-nobaseline")).toBeVisible();
});
