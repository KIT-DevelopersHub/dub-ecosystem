// ロールの削除 — real browser, DEMO transport.
//   1. 初期表示 (システムロール): 削除ボタンは無く、削除できる対象を案内する。
//   2. カスタムロール: 確認ダイアログに影響人数が出て、確定すると一覧から消える。
//   3. 自動ロール (チーム): 同期で作り直される旨を確認ダイアログで警告する。
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("システムロールには削除ボタンを出さず、案内を表示する", async ({ page }) => {
  await page.goto("/admin/roles?demo_account=usr_demo");
  await expect(page.getByText("ロールの削除は、選択したロールのパネル右上から行えます。")).toBeVisible();
  await expect(page.getByTestId("fe7-roles-delete-unavailable")).toHaveText("削除できるのはシステム以外のロールです");
  await page.screenshot({ path: shot("role-delete-01-system.png"), fullPage: true });
});

test("カスタムロールを確認ダイアログ経由で削除できる", async ({ page }) => {
  await page.goto("/admin/roles?demo_account=usr_demo&role=role_lead");
  await page.getByTestId("fe7-roles-delete-role_lead").click();
  const dialog = page.getByTestId("fe7-roles-delete-confirm");
  await expect(dialog).toContainText("「統括」を削除します。");
  await expect(dialog).toContainText("元に戻せません。");
  await page.screenshot({ path: shot("role-delete-02-confirm.png") });

  await dialog.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByTestId("fe7-roles-open-role_lead")).toHaveCount(0);
  await expect(page.getByText("ロールを削除しました").first()).toBeVisible();
  // 選択は先頭のシステムロールに戻り、画面が空にならない。
  await expect(page.getByTestId("fe7-roles-delete-unavailable")).toBeVisible();
});

test("チームの自動ロールは同期で作り直される旨を警告する", async ({ page }) => {
  await page.goto("/admin/roles?demo_account=usr_demo");
  await page.getByTestId("fe7-roles-group-toggle-team").click();
  await page.getByTestId("fe7-roles-group-list-team").getByRole("tab").first().click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByTestId("fe7-roles-delete-confirm")).toContainText("次回の同期で権限なしのロールとして作り直されます");
  await page.screenshot({ path: shot("role-delete-03-managed.png") });
});
