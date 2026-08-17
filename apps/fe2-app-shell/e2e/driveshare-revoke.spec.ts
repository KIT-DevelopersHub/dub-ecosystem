// Drive-share revoke fix E2E (real browser, DEMO transport / mock Drive). Proves the
// fix for the production "cannotDeletePermission" bug: a permission INHERITED from a
// parent folder is shown read-only (継承 badge + reason, no role select / no revoke /
// link locked off) instead of offering a revoke that Google rejects with 403; while a
// DIRECT permission on the same file still revokes successfully. No real Drive touched.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "/Users/kota/DubVault/docs/drive-revoke-fix";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("inherited permission is read-only; direct permission still revokes", async ({ page }) => {
  await page.goto("/driveshare");
  await expect(page.getByTestId("fe2-driveshare")).toBeVisible();

  // Surface the child file that carries inherited permissions via global search.
  await page.getByTestId("fe2-driveshare-search").fill("全体スケジュール");
  const scheduleRow = page.getByTestId("fe2-driveshare-file").filter({ hasText: "全体スケジュール" });
  await expect(scheduleRow).toBeVisible();
  await scheduleRow.click();
  await expect(page.getByTestId("fe2-driveshare-panel")).toBeVisible();
  await expect(page.getByTestId("fe2-driveshare-permission").first()).toBeVisible();

  // (1) The INHERITED user row (staff-a@example.com) is read-only: 継承 badge + reason,
  //     and NO actionable controls.
  const inheritedRow = page.getByTestId("fe2-driveshare-permission").filter({ hasText: "staff-a@example.com" });
  await expect(inheritedRow).toBeVisible();
  await expect(inheritedRow.getByTestId("fe2-driveshare-inherited-badge")).toBeVisible();
  await expect(inheritedRow.getByTestId("fe2-driveshare-inherited-reason")).toBeVisible();
  await expect(inheritedRow.getByTestId("fe2-driveshare-revoke")).toHaveCount(0);
  await expect(inheritedRow.getByTestId("fe2-driveshare-role-select")).toHaveCount(0);

  // (2) Link sharing is inherited too → the switch is locked off with a reason.
  await expect(page.getByTestId("fe2-driveshare-link-switch")).toBeDisabled();
  await expect(page.getByTestId("fe2-driveshare-link-inherited-reason")).toBeVisible();
  await page.screenshot({ path: shot("01-inherited-readonly.png"), fullPage: true });

  // (3) The DIRECT row (ops@example.com) DOES have controls and revokes successfully.
  const directRow = page.getByTestId("fe2-driveshare-permission").filter({ hasText: "ops@example.com" });
  await expect(directRow.getByTestId("fe2-driveshare-revoke")).toBeVisible();
  const rowsBefore = await page.getByTestId("fe2-driveshare-permission").count();
  await directRow.getByTestId("fe2-driveshare-revoke").click();
  await expect(page.getByTestId("fe2-driveshare-revoke-confirm")).toBeVisible();
  await page.getByRole("button", { name: "剥奪する" }).click();
  // direct row disappears; inherited row remains
  await expect(page.getByTestId("fe2-driveshare-permission").filter({ hasText: "ops@example.com" })).toHaveCount(0);
  await expect(page.getByTestId("fe2-driveshare-permission")).toHaveCount(rowsBefore - 1);
  await expect(page.getByTestId("fe2-driveshare-permission").filter({ hasText: "staff-a@example.com" })).toBeVisible();
  await page.screenshot({ path: shot("02-direct-revoked.png"), fullPage: true });
});
