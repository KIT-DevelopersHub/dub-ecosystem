// 運営メンバー 論理削除(削除済み) E2E (real browser, DEMO transport / no gateway).
//   (a) 「メンバーを削除」ボタン → 削除/復帰ダイアログで運営メンバーを論理削除できる;
//   (b) 削除済みは「削除済み」バッジで残り、組織図(体制図)には表示されない;
//   (c) 「在籍に戻す」で復帰できる。
// demo seed には削除済みメンバー member_7「退 太郎」を仕込んである。
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = process.env.MEMBERS_DELETE_SHOTS ?? "/Users/kota/DubVault/docs/members-soft-delete";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("(a) 「メンバーを削除」ボタン→ダイアログで運営メンバーを論理削除する", async ({ page }) => {
  await page.goto("/members");
  await expect(page.getByTestId("members-page")).toBeVisible();
  // 追加/チーム追加の隣に「メンバーを削除」ボタンがある。
  await expect(page.getByTestId("members-delete-open")).toBeVisible();
  await page.screenshot({ path: shot("01-toolbar.png"), fullPage: true });

  await page.getByTestId("members-delete-open").click();
  const dialog = page.getByTestId("members-delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("members-delete-active")).toBeVisible();
  await page.screenshot({ path: shot("02-delete-dialog.png"), fullPage: true });

  // 「石井」(member_e2) を検索して削除 → 確認ダイアログ必須 → 実行で status=deleted。
  await page.getByTestId("members-delete-search").fill("石井");
  await page.getByTestId("members-delete-member_e2").click();
  const confirm = page.getByTestId("members-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/石井/)).toBeVisible();
  await expect(confirm.getByRole("heading", { name: "メンバーを削除しますか？" })).toBeVisible();
  await page.waitForTimeout(400); // let the confirm overlay finish its fade-in before the shot
  await page.screenshot({ path: shot("03-delete-confirm.png"), fullPage: true });
  await confirm.getByRole("button", { name: "削除済みにする" }).click();
  // 削除後は「削除済み」セクションに移り、在籍に戻すボタンが出る。
  await expect(dialog.getByTestId("members-restore-member_e2")).toBeVisible();
  await page.screenshot({ path: shot("04-after-delete.png"), fullPage: true });
  await page.getByTestId("members-delete-close").click();
});

test("(b) 削除済みは一覧で『削除済み』バッジ・組織図では非表示", async ({ page }) => {
  await page.goto("/members");
  await expect(page.getByTestId("members-page")).toBeVisible();
  // チーム別: 削除済み member_7「退 太郎」は「削除済み」バッジで表示される。
  await expect(page.getByTestId("members-status-member_7")).toHaveText("削除済み");
  await page.screenshot({ path: shot("05-team-view-deleted-badge.png"), fullPage: true });

  // 組織図: 削除済みは出ない。
  await page.getByTestId("members-tabs-tab-org").click();
  await expect(page.getByTestId("members-orgchart")).toBeVisible();
  await expect(page.getByTestId("members-orgchip-member_7")).toHaveCount(0);
  await page.screenshot({ path: shot("06-orgchart-no-deleted.png"), fullPage: true });
});

test("(c) 削除済みメンバーを『在籍に戻す』で復帰できる", async ({ page }) => {
  await page.goto("/members");
  await expect(page.getByTestId("members-page")).toBeVisible();
  await page.getByTestId("members-delete-open").click();
  const dialog = page.getByTestId("members-delete-dialog");
  await expect(dialog).toBeVisible();
  // 削除済みセクションの member_7 を在籍に戻す。
  await expect(dialog.getByTestId("members-restore-member_7")).toBeVisible();
  await dialog.getByTestId("members-restore-member_7").click();
  // 復帰後は削除済みセクションから消える（在籍に戻る）。
  await expect(dialog.getByTestId("members-restore-member_7")).toHaveCount(0);
  await page.screenshot({ path: shot("07-after-restore.png"), fullPage: true });
});

test("(d) 物理削除: 削除済みだけに出る→強い確認→完全消滅（在籍中には出ない）", async ({ page }) => {
  await page.goto("/members");
  await expect(page.getByTestId("members-page")).toBeVisible();
  await page.getByTestId("members-delete-open").click();
  const dialog = page.getByTestId("members-delete-dialog");
  await expect(dialog).toBeVisible();

  // 在籍中(member_e1 白木)には物理削除ボタンは出ない。
  await expect(dialog.getByTestId("members-purge-member_e1")).toHaveCount(0);
  // 削除済み member_7 には「在籍に戻す」と「物理削除」の2択。
  await expect(dialog.getByTestId("members-restore-member_7")).toBeVisible();
  await expect(dialog.getByTestId("members-purge-member_7")).toBeVisible();
  await page.screenshot({ path: shot("08-deleted-two-actions.png"), fullPage: true });

  // 物理削除 → 強い確認ダイアログ（不可逆・氏名明示）。
  await dialog.getByTestId("members-purge-member_7").click();
  const confirm = page.getByTestId("members-purge-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("heading", { name: /完全に削除しますか/ })).toBeVisible();
  await expect(confirm.getByText(/退 太郎/)).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("09-purge-confirm.png"), fullPage: true });
  await confirm.getByRole("button", { name: "完全に削除する" }).click();

  // 完全消滅: ダイアログの削除済みから消え、チーム別・組織図にも出ない。
  await expect(dialog.getByTestId("members-purge-member_7")).toHaveCount(0);
  await page.getByTestId("members-delete-close").click();
  await expect(page.getByTestId("members-teamrow-member_7")).toHaveCount(0);
  await page.getByTestId("members-tabs-tab-org").click();
  await expect(page.getByTestId("members-orgchart")).toBeVisible();
  await expect(page.getByTestId("members-orgchip-member_7")).toHaveCount(0);
  await page.screenshot({ path: shot("10-after-purge.png"), fullPage: true });
});
