// Hackit Drive sharing manager E2E (real browser, DEMO transport / mock Drive). Covers:
//   (a) the file list renders (folders first) and selecting a file loads its permissions;
//   (b) grant a new email → the permission row appears;
//   (c) change a non-owner role via the select (optimistic);
//   (d) revoke via the confirm dialog → the row disappears;
//   (e) toggle link sharing on → the "リンク共有中" badge appears on the file row.
// All navigation after the first goto is SPA (in-app clicks) so the in-memory demo
// drive store survives until the assertions. No real Google Drive is touched.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Screenshots land in the shared review folder (absolute path), per the review workflow.
const SHOTS = "/Users/kota/DubVault/docs/driveshare-review";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("list → select → grant → change role → revoke → link sharing", async ({ page }) => {
  await page.goto("/driveshare");
  await expect(page.getByTestId("fe2-driveshare")).toBeVisible();

  // (a) files listed, right panel empty until a selection.
  const files = page.getByTestId("fe2-driveshare-file");
  await expect(files.first()).toBeVisible();
  expect(await files.count()).toBeGreaterThan(0);
  await expect(page.getByTestId("fe2-driveshare-noselection")).toBeVisible();
  await page.screenshot({ path: shot("01-file-list.png"), fullPage: true });

  // select the budget spreadsheet → its permissions load.
  await page.getByRole("button", { name: /予算管理/ }).click();
  await expect(page.getByTestId("fe2-driveshare-panel")).toBeVisible();
  // wait for the permissions query to resolve (rows render) before counting.
  await expect(page.getByTestId("fe2-driveshare-permission").first()).toBeVisible();
  const rowsBefore = await page.getByTestId("fe2-driveshare-permission").count();
  expect(rowsBefore).toBeGreaterThan(0);
  await page.screenshot({ path: shot("02-permissions.png"), fullPage: true });

  // (b) grant a new reader.
  await page.getByTestId("fe2-driveshare-grant-email").fill("volunteer@example.com");
  await page.getByTestId("fe2-driveshare-grant-submit").click();
  await expect(page.getByTestId("fe2-driveshare-permission")).toHaveCount(rowsBefore + 1);
  const grantedRow = page
    .getByTestId("fe2-driveshare-permission")
    .filter({ hasText: "volunteer@example.com" });
  await expect(grantedRow).toBeVisible();
  await page.screenshot({ path: shot("03-after-grant.png"), fullPage: true });

  // (c) change the newly-granted row's role to 編集者 (writer) via its select.
  await grantedRow.getByTestId("fe2-driveshare-role-select").selectOption("writer");
  await expect(grantedRow.getByTestId("fe2-driveshare-role-select")).toHaveValue("writer");

  // (d) revoke it through the confirm dialog.
  await grantedRow.getByTestId("fe2-driveshare-revoke").click();
  await expect(page.getByTestId("fe2-driveshare-revoke-confirm")).toBeVisible();
  await page.getByRole("button", { name: "剥奪する" }).click();
  await expect(page.getByTestId("fe2-driveshare-permission")).toHaveCount(rowsBefore);
  await expect(
    page.getByTestId("fe2-driveshare-permission").filter({ hasText: "volunteer@example.com" }),
  ).toHaveCount(0);
  await page.screenshot({ path: shot("04-after-revoke.png"), fullPage: true });

  // (e) turn link sharing on for the SELECTED file (予算管理.xlsx) → its own file row
  // gains a リンク共有中 badge (proving the toggle, not the pre-seeded チラシ badge).
  const budgetFileRow = page.getByTestId("fe2-driveshare-file").filter({ hasText: "予算管理" });
  await expect(budgetFileRow.getByTestId("fe2-driveshare-linkbadge")).toHaveCount(0);
  // click the switch's label (the styled track overlays the hidden input).
  await page.locator('label[for="fe2-driveshare-link-fil_budget"]').click();
  await expect(page.getByTestId("fe2-driveshare-link-switch")).toBeChecked();
  await expect(budgetFileRow.getByTestId("fe2-driveshare-linkbadge")).toBeVisible();
  await page.screenshot({ path: shot("05-link-shared.png"), fullPage: true });
});
