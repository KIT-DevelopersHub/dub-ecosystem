// Real-browser proof of the ロール管理 layout after the policy-layer refactor:
//   1. 画面は「アプリのアクセス権」（アプリ × 無効/閲覧/編集）が一番上、その下に「その他」。
//      メッセージ削除ポリシーはこの画面から撤去済み（どこにも存在しない）。
//   2. アプリ名クリック → 詳細ダイアログに 3 段階 + そのアプリ配下の細かい権限。
//   3. 「その他」は分類ごと 1 行で、クリックすると組織横断の権限がダイアログで開く。
// Screenshots land in e2e/.output (the vitest suite stays the primary regression).
import { test, expect } from "@playwright/test";

test("ロール管理: アプリのアクセス権が軸、アプリ内の話はアプリのダイアログの中", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("fe7-nav-shield").click();

  // 一覧: ロールのタブ + アプリ別 3 段階の表
  await expect(page.getByTestId("fe7-roles-list")).toBeVisible();
  const table = page.getByTestId("fe7-role-role_admin-app-access-table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("heading", { name: "アプリのアクセス権" })).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_admin-app-level-chat")).toBeVisible();

  // メッセージ削除ポリシーはこの画面から撤去した
  await expect(page.getByTestId("fe7-chat-deletion-policy")).toHaveCount(0);

  // 「その他」= 分類ごと 1 行（トグルを並べない）
  const other = page.getByTestId("fe7-role-role_admin-other-permissions");
  await expect(other).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_admin-other-name-infra")).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_admin-other-toggle-infra:deploy")).toHaveCount(0);
  // アプリに引き取られた分類は「その他」に残らない
  await expect(page.getByTestId("fe7-role-role_admin-other-name-identity")).toHaveCount(0);
  await expect(page.getByTestId("fe7-role-role_admin-other-name-file")).toHaveCount(0);
  await page.screenshot({ path: "e2e/.output/10-roles-policy-overview.png", fullPage: true });

  // チャットのダイアログ: 3 段階 + そのアプリ配下の細かい権限
  await page.getByTestId("fe7-role-role_admin-app-name-chat").click();
  const dialog = page.getByTestId("fe7-role-role_admin-app-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("fe7-role-role_admin-app-dialog-level")).toBeVisible();
  await expect(dialog.getByTestId("fe7-role-role_admin-app-dialog-toggle-chat:moderate")).toBeVisible();
  await expect(dialog.getByTestId("fe7-chat-deletion-policy")).toHaveCount(0);
  await dialog.screenshot({ path: "e2e/.output/11-roles-policy-chat-dialog.png" });

  // 「無効」にすると配下の細かい権限は触れない（アプリを ON にして初めて使える）
  await dialog.getByTestId("fe7-role-role_admin-app-dialog-level-none").click();
  await expect(dialog.getByTestId("fe7-role-role_admin-app-dialog-detail-locked")).toBeVisible();
  await expect(dialog.getByTestId("fe7-role-role_admin-app-dialog-toggle-chat:moderate")).toBeDisabled();
  await page.screenshot({ path: "e2e/.output/11b-roles-policy-detail-locked.png" });
  await dialog.getByTestId("fe7-role-role_admin-app-dialog-level-view").click();
  await expect(dialog.getByTestId("fe7-role-role_admin-app-dialog-toggle-chat:moderate")).toBeEnabled();
  await dialog.getByTestId("fe7-role-role_admin-app-dialog-close").click();
  await expect(dialog).toHaveCount(0);

  // 「その他」のダイアログ: 組織横断の権限をここで ON/OFF する
  await page.getByTestId("fe7-role-role_admin-other-name-infra").click();
  const otherDialog = page.getByTestId("fe7-role-role_admin-other-dialog");
  await expect(otherDialog).toBeVisible();
  const deploy = otherDialog.getByTestId("fe7-role-role_admin-other-toggle-infra:deploy");
  await expect(deploy).not.toBeChecked();
  // @dub/ui Switch hides the real checkbox under its track, so drive it the way a user
  // does: click the label (native label→input activation).
  await otherDialog.locator('label[for="fe7-role-role_admin-other-infra:deploy"]').click();
  await expect(deploy).toBeChecked();
  await otherDialog.screenshot({ path: "e2e/.output/12-roles-policy-other-dialog.png" });
  await otherDialog.getByTestId("fe7-role-role_admin-other-dialog-close").click();

  // 閉じると行の許可数に反映される（保存はページ下の「保存」で確定）
  await expect(page.getByTestId("fe7-role-role_admin-other-granted-infra")).toHaveText("1 / 4");
  await expect(page.getByTestId("fe7-role-role_admin-save")).toBeEnabled();
});
