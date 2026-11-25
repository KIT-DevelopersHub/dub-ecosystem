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

test("ロール管理: 保存すると離脱確認が残らず、アプリに必須の権限は固定で見える", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  const leavePrompted = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });

  await page.goto("/");
  await page.getByTestId("fe7-nav-shield").click();
  await page.getByTestId("fe7-roles-open-role_organizer").click();
  const ns = "fe7-role-role_organizer";

  // LP管理 を有効にすると、必須の infra:read は ON の固定表示になる
  await page.getByTestId(`${ns}-app-level-lp-view`).click();
  await page.getByTestId(`${ns}-other-name-infra`).click();
  const other = page.getByTestId(`${ns}-other-dialog`);
  await expect(other.getByTestId(`${ns}-other-toggle-infra:read`)).toBeChecked();
  await expect(other.getByTestId(`${ns}-other-toggle-infra:read`)).toBeDisabled();
  await expect(other.getByTestId(`${ns}-other-required-infra:read`)).toHaveText("LP管理に必要");

  // 「その他」の変更が保存でき、保存後は離脱確認が出ない
  await other.locator(`label[for="${ns}-other-infra:deploy"]`).click();
  await other.screenshot({ path: "e2e/.output/13-roles-required-key.png" });
  await other.getByTestId(`${ns}-other-dialog-close`).click();
  expect(await leavePrompted()).toBe(true);

  await page.getByTestId(`${ns}-save`).click();
  await page.getByTestId(`${ns}-save-confirm`).getByRole("button", { name: "確認" }).click();
  await expect(page.getByText("ロールを保存しました")).toBeVisible();
  await expect(page.getByText("変更はありません")).toHaveCount(0);
  await expect.poll(leavePrompted).toBe(false);

  await page.reload();
  expect(dialogs).toEqual([]);
});
