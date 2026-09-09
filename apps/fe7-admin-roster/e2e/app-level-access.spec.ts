// Real-browser proof of the 2-stage app access control: 有効/無効 → (有効なら) レベル選択
// (閲覧/編集・作成/管理). Drives role_member (which starts with the mail app OFF) through
// off -> 閲覧 -> 編集・作成 -> 管理, checking the badge + level pills at each step, then opens
// 詳細 to confirm the underlying permission keys are exactly what the level implies.
// Screenshot is written next to the spec.
import { test, expect } from "@playwright/test";

test("app access: off -> 閲覧 -> 編集・作成 -> 管理 maps to the right permission keys", async ({ page }) => {
  await page.goto("/");

  // Navigate to ロール管理, select the "member" role (mail app starts OFF for it).
  await page.getByTestId("fe7-nav-shield").click();
  await page.getByTestId("fe7-roles-open-role_member").click();

  const mailRow = page.getByTestId("fe7-role-role_member-app-mail");
  await expect(mailRow).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_member-app-state-mail")).toHaveText("無効");
  await expect(page.getByTestId("fe7-role-role_member-app-level-mail")).toHaveCount(0);

  // OFF -> 有効化 (defaults to 閲覧まで): app:mail:view + mail:read turn on.
  await page.locator('label[for="fe7-role-role_member-appsw-mail"]').click();
  await expect(page.getByTestId("fe7-role-role_member-app-state-mail")).toHaveText("閲覧");
  await expect(page.getByTestId("fe7-role-role_member-app-level-mail-view")).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "e2e/.output/app-level-01-view.png", fullPage: true });

  // 閲覧 -> 編集・作成: app:mail:edit + mail:send turn on (view stays on).
  await page.getByTestId("fe7-role-role_member-app-level-mail-edit").click();
  await expect(page.getByTestId("fe7-role-role_member-app-state-mail")).toHaveText("編集・作成");

  // 編集・作成 -> 管理: mail:admin + mail:read_all turn on too.
  await page.getByTestId("fe7-role-role_member-app-level-mail-manage").click();
  await expect(page.getByTestId("fe7-role-role_member-app-state-mail")).toHaveText("管理");
  await page.screenshot({ path: "e2e/.output/app-level-02-manage.png", fullPage: true });

  // 詳細 discloses the individual keys — all ON at 管理.
  await page.getByTestId("fe7-role-role_member-app-details-toggle-mail").click();
  await expect(page.getByTestId("fe7-role-role_member-app-detail-mail-mail:read")).toBeChecked();
  await expect(page.getByTestId("fe7-role-role_member-app-detail-mail-mail:send")).toBeChecked();
  await expect(page.getByTestId("fe7-role-role_member-app-detail-mail-mail:admin")).toBeChecked();
  await expect(page.getByTestId("fe7-role-role_member-app-detail-mail-mail:read_all")).toBeChecked();
  await page.screenshot({ path: "e2e/.output/app-level-03-details.png", fullPage: true });

  // Fine-tune via 詳細: turn OFF just mail:read_all directly (level stays 管理 — the
  // level badge is a best-effort summary, the underlying keys are the real truth).
  // The Switch's visual track overlays the (visually hidden) checkbox input, so click
  // the associated <label> as a real user does (same pattern as the role matrix e2e).
  await page.locator('label[for="fe7-role-role_member-app-detail-mail-mail:read_all-sw"]').click();
  await expect(page.getByTestId("fe7-role-role_member-app-detail-mail-mail:read_all")).not.toBeChecked();

  // 有効化 OFF collapses everything again (level selector + 詳細 gone).
  await page.locator('label[for="fe7-role-role_member-appsw-mail"]').click();
  await expect(page.getByTestId("fe7-role-role_member-app-state-mail")).toHaveText("無効");
  await expect(page.getByTestId("fe7-role-role_member-app-level-mail")).toHaveCount(0);

  // A shared-domain app (gantt: tasks+gantt) only offers 閲覧/編集・作成, no 管理, no 詳細.
  const ganttRow = page.getByTestId("fe7-role-role_member-app-gantt");
  await expect(ganttRow).toBeVisible();
  await page.locator('label[for="fe7-role-role_member-appsw-gantt"]').click();
  await expect(page.getByTestId("fe7-role-role_member-app-level-gantt-view")).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_member-app-level-gantt-edit")).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_member-app-level-gantt-manage")).toHaveCount(0);
  await expect(page.getByTestId("fe7-role-role_member-app-details-toggle-gantt")).toHaveCount(0);

  // Save persists the whole change set through the existing role-save flow.
  await page.getByTestId("fe7-role-role_member-save").click();
  const confirm = page.getByTestId("fe7-role-role_member-save-confirm");
  await confirm.getByRole("button", { name: "確認" }).click();
  await expect(page.getByTestId("fe7-role-role_member-permission-matrix")).toBeVisible();
});
