// スポンサー営業進捗の E2E (実ブラウザ・DEMO transport)。集計 → 表でステータス変更 → 詳細で編集 → 貼り付け取り込み → 追加分の反映。
import { test, expect } from "@playwright/test";

const SHOTS = process.env.SPONSOR_SHOTS;
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const stat = (page: import("@playwright/test").Page, key: string) => page.getByTestId(`fe2-sponsor-lead-stat-${key}`);

const SHEET = [
  "No.\t企業名\t業界\t営業担当\tステータス\t想定協賛額（任意）\t次回アクション日",
  "1\t（株）北陸テック\tIT・SaaS\t鈴木\t未接触\t\t",
  '2\t貼付テスト株式会社\tその他\t松島\t提案済\t¥150,000\t"2026/12/1"',
  "3\t\t\t\t\t\t",
].join("\n");

test("営業タブ: 集計・ステータス変更・編集・取り込み", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/sponsor/leads");
  await expect(page.getByTestId("fe2-sponsor-leads-table")).toBeVisible();
  await expect(stat(page, "total")).toHaveText("10");
  await shot(page, "01-table");

  // 表の中でステータスを変えると集計が変わる。
  await expect(stat(page, "agreed")).toHaveText("1");
  await page.getByTestId("fe2-sponsor-lead-status-lead_demo_1").selectOption("契約済");
  await expect(stat(page, "agreed")).toHaveText("2");

  // 詳細で編集。名刺へのリンクも出る。
  await page.getByTestId("fe2-sponsor-lead-lead_demo_4").click();
  await expect(page.getByTestId("fe2-sponsor-lead-detail")).toBeVisible();
  await shot(page, "02-detail");
  await page.getByTestId("fe2-sponsor-lead-edit").click();
  await page.getByTestId("fe2-sponsor-lead-field-nextAction").fill("E2E で更新");
  await shot(page, "03-edit");
  await page.getByTestId("fe2-sponsor-lead-edit-save").click();
  await expect(page.getByTestId("fe2-sponsor-lead-detail")).toContainText("E2E で更新");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fe2-sponsor-leads-table")).toContainText("E2E で更新");

  // 貼り付け取り込み: 登録済みは飛ばし、新しい行だけ入る。
  await page.getByTestId("fe2-sponsor-lead-import-open").click();
  await page.getByTestId("fe2-sponsor-lead-import-text").fill(SHEET);
  await expect(page.getByTestId("fe2-sponsor-lead-import-preview")).toContainText("1 社を追加します");
  await expect(page.getByTestId("fe2-sponsor-lead-import-preview")).toContainText("登録済みの 1 社");
  await shot(page, "04-import");
  await page.getByTestId("fe2-sponsor-lead-import-submit").click();
  await expect(stat(page, "total")).toHaveText("11");
  await expect(page.getByTestId("fe2-sponsor-leads-table")).toContainText("貼付テスト株式会社");

  // 絞り込み。
  await page.getByTestId("fe2-sponsor-leads-search").fill("貼付テスト");
  await expect(page.getByTestId("fe2-sponsor-lead-name")).toHaveCount(1);
  await shot(page, "05-filtered");

  expect(errors).toEqual([]);
});

test("タブから遷移でき、スマホ幅でも横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sponsor");
  await page.getByRole("tab", { name: "営業" }).click();
  await expect(page).toHaveURL(/\/sponsor\/leads$/);
  await expect(stat(page, "total")).toHaveText("10");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "06-mobile");
});
