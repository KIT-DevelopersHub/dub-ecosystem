// 参加届 E2E (real browser, DEMO transport / no gateway). Proves the single-source-of-truth
// design the 社長 asked for:
//   (a) the PUBLIC form at /participate (no login) accepts the two required emails and
//       shows the サンクス — this is the one form participants use;
//   (b) the in-shell /participation renders the SAME form component and links out to the
//       public /participate URL (運営 share that link, no second form to maintain);
//   (c) the 運営専用 回答一覧 at /participation/list shows submitted 参加届 (氏名 / 学校メール /
//       Gmail / 所属 / 希望) and opens a detail drawer on row click.
// The list is seeded with two submitted records so it has content on first load; a real
// submit also pushes onto the same in-memory store.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "/Users/kota/DubVault/docs/participation-fields";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("(a) public /participate accepts split 姓/名 + emails + phone and confirms", async ({ page }) => {
  await page.goto("/participate");
  await expect(page.getByTestId("participation-public-page")).toBeVisible();

  // 新レイアウト: 氏名[姓/名] → 振り仮名[せい/めい] → メール → 電話
  await page.getByTestId("participation-last-name").fill("公開");
  await page.getByTestId("participation-first-name").fill("太郎");
  await page.getByTestId("participation-last-name-kana").fill("こうかい");
  await page.getByTestId("participation-first-name-kana").fill("たろう");
  await page.getByTestId("participation-school-email").fill("koukai@school.ac.jp");
  await page.getByTestId("participation-gmail").fill("koukai.taro@gmail.com");
  await page.getByTestId("participation-phone").fill("090-1234-5678");
  await page.screenshot({ path: shot("01-public-form.png"), fullPage: true });

  await page.getByTestId("participation-submit").click();
  await expect(page.getByTestId("participation-thanks")).toBeVisible();
  await page.screenshot({ path: shot("02-public-thanks.png"), fullPage: true });
});

test("(b) in-shell /participation reuses the same form and links to the public URL", async ({ page }) => {
  await page.goto("/participation");
  await expect(page.getByTestId("participation-page")).toBeVisible();
  // Same form component (両メール必須) as the public page.
  await expect(page.getByTestId("participation-school-email")).toBeVisible();
  await expect(page.getByTestId("participation-gmail")).toBeVisible();
  // 導線: link out to the public /participate form (no second implementation).
  const link = page.getByTestId("participation-public-link").locator("a");
  await expect(link).toHaveAttribute("href", "/participate");
  await page.screenshot({ path: shot("03-inshell-form-with-link.png"), fullPage: true });
});

test("(c) 運営 回答一覧 lists submitted 参加届 and opens a detail drawer", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-list-page")).toBeVisible();
  await expect(page.getByTestId("participation-list-table")).toBeVisible();

  // Seeded submissions show 氏名 + 学校メール + Gmail.
  await expect(page.getByText("kurokawa@school.ac.jp")).toBeVisible();
  await expect(page.getByText("tanaka.minoru@gmail.com")).toBeVisible();
  await page.screenshot({ path: shot("04-list.png"), fullPage: true });

  // Row click → detail drawer with the full record.
  await page.getByText("田中 実").click();
  const detail = page.getByTestId("participation-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByText("tanaka@school.ac.jp")).toBeVisible();
  await expect(detail.getByText("電気電子工学科")).toBeVisible();
  await page.waitForTimeout(500); // let the drawer slide-in settle before the shot
  await page.screenshot({ path: shot("05-detail.png"), fullPage: true });
});
