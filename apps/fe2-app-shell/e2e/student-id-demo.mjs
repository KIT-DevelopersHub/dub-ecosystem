// Playwright E2E for 学籍番号 (studentId) against a live demo build.
// 運営名簿: 一覧に学籍番号列(seed) -> 編集ダイアログで形式エラー/全角正規化保存 -> 一覧に反映.
// 参加届: 回答一覧に学籍番号列(seed) -> 追加する(新規) -> 名簿に引き継ぎ -> 公開フォームで形式エラー/送信.
// Usage: E2E_BASE=https://dub-demo-student-id.developershub-site.workers.dev node e2e/student-id-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/student-id-e2e");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };
const ERR = "学籍番号は 1400980 のように 7 桁の数字で入力してください";

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // (1) 運営名簿の表に学籍番号列 + seed 値
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  const table = page.getByTestId("members-table");
  await table.waitFor({ timeout: 20000 });
  await table.getByRole("columnheader", { name: "学籍番号" }).waitFor();
  if (!(await table.getByText(/^1[2-6]\d{5}$/).first().count())) fail("seeded 学籍番号 not shown");
  ok("運営名簿 has 学籍番号 column with seeded 7-digit values");
  await shot(page, "01-roster-list.png");

  // (2) 編集ダイアログ: 140098 はエラー、１４００９８０ は 1400980 で保存
  await page.getByTestId("member-roster-search").fill("黒川");
  await table.getByRole("button", { name: /黒川.*を編集/ }).first().click();
  const dialog = page.getByTestId("members-form-dialog");
  await dialog.waitFor();
  const input = dialog.getByTestId("members-form-student-id");
  if ((await input.getAttribute("inputmode")) !== "numeric") fail("学籍番号 input lacks inputmode=numeric");
  await input.fill("140098");
  await dialog.getByTestId("members-form-submit").click();
  await dialog.getByText(ERR).waitFor({ timeout: 5000 });
  ok("edit dialog rejects 140098 with message");
  await shot(page, "02-edit-error.png");

  await input.fill("１４００９８０");
  await dialog.getByTestId("members-form-submit").click();
  await dialog.waitFor({ state: "hidden", timeout: 10000 });
  await page.getByTestId("member-roster-search").fill("1400980");
  const saved = table.getByRole("row").filter({ hasText: "黒川" });
  await saved.getByText("1400980", { exact: true }).waitFor({ timeout: 10000 });
  ok("全角 １４００９８０ が 1400980 に正規化されて保存・検索できる");
  await shot(page, "03-edit-saved.png");

  // (3) 参加届: 回答一覧に学籍番号列 (seed) -> 追加する(新規) で名簿へ引き継ぎ
  await page.getByTestId("member-roster-subnav-tab-participation-list").click();
  const plist = page.getByTestId("participation-list-table");
  await plist.waitFor({ timeout: 20000 });
  await plist.getByRole("columnheader", { name: "学籍番号" }).waitFor();
  const tanaka = plist.getByRole("row").filter({ hasText: "田中 実" });
  if (!(await tanaka.getByText("1500431", { exact: true }).count())) fail("seeded 参加届 学籍番号 not shown");
  ok("参加届の回答一覧 has 学籍番号 column with seeded value");
  await shot(page, "04-participation-list.png");

  await tanaka.getByRole("button", { name: "追加する" }).click();
  await page.getByTestId("participation-resolve-create").click();
  await tanaka.getByText(/追加済/).waitFor({ timeout: 10000 });
  await page.getByTestId("participation-issue-mail-later").click().catch(() => {});
  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  await table.waitFor({ timeout: 20000 });
  await page.getByTestId("member-roster-search").fill("1500431");
  await table.getByText(/田中\s*実/).first().waitFor({ timeout: 10000 });
  ok("追加する(新規) で学籍番号が名簿に引き継がれ、名簿で検索できる");
  await shot(page, "05-handoff.png");

  // (4) 公開の参加届フォーム (/participate): 14009801 はエラー、全角 7 桁は送信できる
  await page.goto(`${BASE}/participate`, { waitUntil: "networkidle" });
  const sid = page.getByTestId("participation-student-id");
  await sid.waitFor({ timeout: 20000 });
  if ((await sid.getAttribute("inputmode")) !== "numeric") fail("参加届 学籍番号 lacks inputmode=numeric");
  await page.getByTestId("participation-last-name").fill("学籍");
  await page.getByTestId("participation-first-name").fill("花子");
  await page.getByTestId("participation-school-email").fill("gakuseki@school.ac.jp");
  await page.getByTestId("participation-gmail").fill("gakuseki@gmail.com");
  await sid.fill("14009801");
  await page.getByTestId("participation-submit").click();
  await page.getByText(ERR).waitFor({ timeout: 5000 });
  ok("参加届フォーム has 学籍番号 and rejects 14009801 with message");
  await shot(page, "06-participate-error.png");

  await sid.fill("１６０１２３４");
  await page.getByTestId("participation-submit").click();
  await page.getByTestId("participation-thanks").waitFor({ timeout: 10000 });
  ok("参加届 submitted with full-width 学籍番号");
  await shot(page, "07-participate-thanks.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
