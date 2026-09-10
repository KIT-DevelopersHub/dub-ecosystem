// メールアドレス管理を「運営メンバー・名簿」の共有サブナビにタブ統合した配置の real-browser
// 検証（VITE_DEMO transport）。ダッシュボードの独立タイル案(ユーザー却下)ではなく、
// MemberRosterSubnav 側にタブとして出ること・一覧/発行/トグル/削除が動くことを確認する。
// スクショは ~/Desktop/dub-email-in-roster-screenshots/ に保存。
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "Desktop", "dub-email-in-roster-screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("運営メンバー・名簿のサブナビに「メールアドレス管理」タブが出て一覧・発行・トグル・削除ができる", async ({
  page,
}) => {
  // ランチャー → 運営メンバー・名簿
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await page.screenshot({ path: shot("01-home.png") });

  await page.getByTestId("fe2-app-launcher-trigger").click();
  await expect(page.getByTestId("dub-launcher-panel")).toBeVisible();
  await page.getByTestId("dub-launcher-panel").getByText("運営メンバー・名簿").click();
  await expect(page.getByTestId("member-roster-app")).toBeVisible();
  await page.screenshot({ path: shot("02-member-roster-opened.png") });

  // 旧案(ダッシュボード管理セクション)が無いことの確認 — 管理タイルの独立グリッドは出ない
  await expect(page.getByTestId("fe2-home-admin-apps-grid")).toHaveCount(0);

  // サブナビに新タブがある
  const subnav = page.getByTestId("member-roster-subnav");
  await expect(subnav).toBeVisible();
  await expect(subnav.getByText("メールアドレス管理")).toBeVisible();
  await page.screenshot({ path: shot("03-subnav-with-email-tab.png") });

  // タブをクリック → /admin/email-routing へ遷移し一覧が表示
  await subnav.getByText("メールアドレス管理").click();
  await expect(page).toHaveURL(/\/admin\/email-routing$/);
  await expect(page.getByTestId("fe7-email-header")).toBeVisible();
  await expect(page.getByTestId("fe7-email-table")).toBeVisible();
  await page.screenshot({ path: shot("04-email-management-list.png") });

  // 発行
  await page.getByTestId("fe7-email-new").click();
  await expect(page.getByTestId("fe7-email-new-dialog")).toBeVisible();
  await page.getByTestId("fe7-email-localpart").fill("e2e-verify");
  await page.getByTestId("fe7-email-submit").click();
  await expect(page.getByText("e2e-verify@developershub.jp")).toBeVisible();
  await page.screenshot({ path: shot("05-issued-new-address.png") });

  // トグル (無効化 → 有効化)
  const row = page.getByText("e2e-verify@developershub.jp").locator("..").locator("..");
  const toggleBtn = row.getByRole("button", { name: "無効にする" });
  await toggleBtn.click();
  await expect(row.getByText("無効")).toBeVisible();
  await page.screenshot({ path: shot("06-toggled-disabled.png") });
  await row.getByRole("button", { name: "有効にする" }).click();
  await expect(row.getByText("有効")).toBeVisible();

  // 削除
  await row.getByRole("button", { name: "削除" }).click();
  await expect(page.getByTestId("fe7-email-delete-confirm")).toBeVisible();
  await page.getByTestId("fe7-email-delete-confirm").getByRole("button", { name: "削除する" }).click();
  await expect(page.getByText("e2e-verify@developershub.jp")).toHaveCount(0);
  await page.screenshot({ path: shot("07-deleted.png") });
});
