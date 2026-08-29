// Drive-share role fan-out — "invited (no Google account)" E2E (real browser, DEMO
// transport / mock Drive). Reproduces the production case where the admin role expands to
// Cloudflare Email-Routing aliases (info@ / admin@developershub.jp) that have NO Google
// account: they ARE shared, but only via an invite, so their access is pending. The
// manager must say so (and suggest sharing with a real Google account) instead of
// implying they can edit. The demo `admin` role is those two aliases.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "/Users/kota/DubVault/docs/drive-role-share-fix";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("admin role → Email-Routing aliases are shared as invited (pending), clearly flagged", async ({ page }) => {
  await page.goto("/driveshare");
  await expect(page.getByTestId("fe2-driveshare")).toBeVisible();

  await page.getByTestId("fe2-driveshare-search").fill("予算管理");
  const fileRow = page.getByTestId("fe2-driveshare-file").filter({ hasText: "予算管理" });
  await expect(fileRow).toBeVisible();
  await fileRow.click();
  await expect(page.getByTestId("fe2-driveshare-role-panel")).toBeVisible();

  // Grant the admin role (writer). Both members are no-Google-account aliases.
  await page.getByTestId("fe2-driveshare-role-picker").selectOption("role_admin");
  await page.getByTestId("fe2-driveshare-role-driverole").selectOption("writer");
  await page.getByTestId("fe2-driveshare-role-submit").click();

  // Warning toast: shared via invite, access pending, with the alternative suggestion.
  const toast = page.getByTestId("toast-warning");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("招待のみ");
  await expect(toast).toContainText("info@developershub.jp");
  await expect(toast).toContainText("admin@developershub.jp");
  await expect(toast).toContainText("Googleアカウント");
  await expect(toast).toContainText("編集できません");

  // The grant row is still created (partial/pending success).
  await expect(page.getByTestId("fe2-driveshare-role-grant")).toBeVisible();
  await expect(page.getByTestId("fe2-driveshare-role-grant-members")).toContainText("2人");
  await page.screenshot({ path: shot("03-admin-invited-pending.png"), fullPage: true });
});
