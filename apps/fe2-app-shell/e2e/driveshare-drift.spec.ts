// 「ロールとの差分」 E2E (real browser, DEMO transport / mock Drive). The demo seeds the
// maintainer role as 編集 on Hackit 2026 共有 while Drive has drifted from it: staff-a (no
// role) still has 編集, araki was lowered to 閲覧, ikeda was never shared. The card lists
// exactly those, and fixing one in the UI (revoking staff-a) drops it from the drift.
import { test, expect } from "@playwright/test";

test("drift card lists shares that differ from the role grants and follows a fix", async ({ page }) => {
  await page.goto("/driveshare");
  await page.getByTestId("fe2-driveshare-search").fill("Hackit 2026");
  await page.getByTestId("fe2-driveshare-file").filter({ hasText: "Hackit 2026 共有" }).click();

  const card = page.getByTestId("fe2-driveshare-drift");
  await expect(card.getByTestId("fe2-driveshare-drift-badge")).toHaveText("差分 3件");
  await expect(card.getByTestId("fe2-driveshare-drift-unexpected")).toContainText("staff-a@example.com");
  await expect(card.getByTestId("fe2-driveshare-drift-insufficient_role")).toContainText("araki@developershub.jp");
  await expect(card.getByTestId("fe2-driveshare-drift-insufficient_role")).toContainText("閲覧者（ロール「maintainer」では編集者）");
  await expect(card.getByTestId("fe2-driveshare-drift-missing")).toContainText("ikeda@developershub.jp");
  await card.screenshot({ path: test.info().outputPath("01-drift.png") });

  // Revoke the out-of-role share from the permission list → the drift refreshes.
  const staffRow = page.getByTestId("fe2-driveshare-permission").filter({ hasText: "staff-a@example.com" });
  await staffRow.getByTestId("fe2-driveshare-revoke").click();
  await page.getByRole("button", { name: "剥奪する" }).click();
  await expect(card.getByTestId("fe2-driveshare-drift-badge")).toHaveText("差分 2件");
  await expect(card.getByTestId("fe2-driveshare-drift-unexpected")).toHaveCount(0);

  // Re-applying the role shares with everyone at 編集 → matches the role.
  await page.getByTestId("fe2-driveshare-role-grant-reapply").click();
  await expect(card.getByTestId("fe2-driveshare-drift-clean")).toContainText("3人が一致");
  await expect(card.getByTestId("fe2-driveshare-drift-badge")).toHaveText("一致");
  await card.screenshot({ path: test.info().outputPath("02-clean.png") });

  // A file without any role grant has nothing to compare with.
  await page.getByTestId("fe2-driveshare-search").fill("予算管理");
  await page.getByTestId("fe2-driveshare-file").filter({ hasText: "予算管理" }).click();
  await expect(card.getByTestId("fe2-driveshare-drift-nobaseline")).toBeVisible();
});
