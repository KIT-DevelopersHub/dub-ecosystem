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

  // 「石井」(member_e2) を検索して削除 → status=deleted。
  await page.getByTestId("members-delete-search").fill("石井");
  await page.getByTestId("members-delete-member_e2").click();
  // 削除後は「削除済み」セクションに移り、在籍に戻すボタンが出る。
  await expect(dialog.getByTestId("members-restore-member_e2")).toBeVisible();
  await page.screenshot({ path: shot("03-after-delete.png"), fullPage: true });
  await page.getByTestId("members-delete-close").click();
});

test("(b) 削除済みは一覧で『削除済み』バッジ・組織図では非表示", async ({ page }) => {
  await page.goto("/members");
  await expect(page.getByTestId("members-page")).toBeVisible();
  // チーム別: 削除済み member_7「退 太郎」は「削除済み」バッジで表示される。
  await expect(page.getByTestId("members-status-member_7")).toHaveText("削除済み");
  await page.screenshot({ path: shot("04-team-view-deleted-badge.png"), fullPage: true });

  // 組織図: 削除済みは出ない。
  await page.getByTestId("members-tabs-tab-org").click();
  await expect(page.getByTestId("members-orgchart")).toBeVisible();
  await expect(page.getByTestId("members-orgchip-member_7")).toHaveCount(0);
  await page.screenshot({ path: shot("05-orgchart-no-deleted.png"), fullPage: true });
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
  await page.screenshot({ path: shot("06-after-restore.png"), fullPage: true });
});
