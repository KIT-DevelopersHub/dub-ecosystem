// Drive-share role-fan-out fix E2E (real browser, DEMO transport / mock Drive). Proves
// the fix for the production bug where "このロールに振る" / "再適用" failed wholesale with
// "Drive rejected the request" when a role member had no Google account. Now the fan-out
// is a PARTIAL success: shareable members are granted, and un-shareable ones (no Google
// account / invalid email) are reported with a Japanese reason instead of failing all.
// The demo `member` role includes one un-shareable address to exercise the skip path.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "/Users/kota/DubVault/docs/drive-role-share-fix";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("role fan-out: applies shareable members, skips un-shareable with a reason", async ({ page }) => {
  await page.goto("/driveshare");
  await expect(page.getByTestId("fe2-driveshare")).toBeVisible();

  // Select a file so the role-sharing panel renders.
  await page.getByTestId("fe2-driveshare-search").fill("予算管理");
  const fileRow = page.getByTestId("fe2-driveshare-file").filter({ hasText: "予算管理" });
  await expect(fileRow).toBeVisible();
  await fileRow.click();
  await expect(page.getByTestId("fe2-driveshare-role-panel")).toBeVisible();

  // "このロールに振る": member role (writer). The member role has 3 members, one of which
  // has no Google account → applied 2, skipped 1.
  await page.getByTestId("fe2-driveshare-role-picker").selectOption("role_member");
  await page.getByTestId("fe2-driveshare-role-driverole").selectOption("writer");
  await page.getByTestId("fe2-driveshare-role-submit").click();

  // Warning toast names the skipped member + reason (NOT a wholesale failure).
  const grantToast = page.getByTestId("toast-warning");
  await expect(grantToast).toBeVisible();
  await expect(grantToast).toContainText("スキップ");
  await expect(grantToast).toContainText("ghost-no-account@example.invalid");
  await expect(grantToast).toContainText("Googleアカウント");
  // The role-grant row is created (partial success), showing the full role size.
  await expect(page.getByTestId("fe2-driveshare-role-grant")).toBeVisible();
  await expect(page.getByTestId("fe2-driveshare-role-grant-members")).toContainText("3人");
  await page.screenshot({ path: shot("01-role-grant-partial.png"), fullPage: true });

  // Let the first toast clear, then "再適用" also succeeds with the same skip report.
  await expect(grantToast).toBeHidden({ timeout: 15000 });
  await page.getByTestId("fe2-driveshare-role-grant-reapply").click();
  const reapplyToast = page.getByTestId("toast-warning");
  await expect(reapplyToast).toBeVisible();
  await expect(reapplyToast).toContainText("再適用");
  await expect(reapplyToast).toContainText("ghost-no-account@example.invalid");
  await page.screenshot({ path: shot("02-reapply-partial.png"), fullPage: true });
});
