// Playwright E2E for 学籍番号 (運営名簿・参加届) against a live demo build.
// /participate (公開フォーム) -> 形式エラー/全角正規化で送信 -> 回答一覧に学籍番号列 -> 追加する(新規) -> 名簿に引き継ぎ.
// Usage: E2E_BASE=https://dub-demo-student-number.developershub-site.workers.dev node e2e/student-number-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "student-number-e2e");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/participate`, { waitUntil: "networkidle" });
  await page.getByTestId("participation-student-number").waitFor({ timeout: 20000 });
  ok("公開の参加届フォームに学籍番号欄がある");

  await page.getByTestId("participation-last-name").fill("学籍");
  await page.getByTestId("participation-first-name").fill("花子");
  await page.getByTestId("participation-school-email").fill("gakuseki@school.ac.jp");
  await page.getByTestId("participation-gmail").fill("gakuseki@gmail.com");
  await page.getByTestId("participation-student-number").fill("140098");
  await page.getByTestId("participation-submit").click();
  await page.getByText("学籍番号は半角数字 7 桁（例: 1400980）で入力してください").waitFor({ timeout: 5000 });
  ok("6 桁は形式エラーで送信できない");
  await shot(page, "01-form-error.png");

  await page.getByTestId("participation-student-number").fill("１４００９８０");
  await page.getByTestId("participation-submit").click();
  await page.getByTestId("participation-thanks").waitFor({ timeout: 10000 });
  ok("全角入力で送信できる");

  // demo のモックはメモリ内なので再読み込みせず SPA 内で遷移する。
  await page.evaluate(() => {
    history.pushState({}, "", "/participation/list");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  const table = page.getByTestId("participation-list-table");
  await table.waitFor({ timeout: 20000 });
  await table.getByRole("columnheader", { name: "学籍番号" }).waitFor();
  const row = table.getByRole("row").filter({ hasText: "学籍 花子" });
  if (!(await row.getByText("1400980").count())) fail("submitted 学籍番号 not normalized/shown in 回答一覧");
  if (!(await table.getByText("1401123").count())) fail("seeded 学籍番号 not shown");
  ok("回答一覧に学籍番号列; 全角入力が 1400980 に正規化");
  await shot(page, "02-list.png");

  await row.getByRole("button", { name: "追加する" }).click();
  await page.getByTestId("participation-resolve-create").click();
  await page.getByTestId("participation-issue-mail-later").click();
  await row.getByText(/追加済/).waitFor({ timeout: 10000 });
  ok("追加する -> 新規で追加 confirmed");

  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  const members = page.getByTestId("members-table");
  await members.waitFor({ timeout: 20000 });
  await members.getByRole("columnheader", { name: "学籍番号" }).waitFor();
  await page.getByTestId("member-roster-search").fill("1400980");
  await members.getByText("学籍 花子").waitFor({ timeout: 10000 });
  if ((await members.getByRole("row").count()) !== 2) fail("学籍番号の検索で他の人まで出る");
  ok("運営名簿に学籍番号列; 確定したメンバーに引き継がれ検索できる");
  await shot(page, "03-members.png");

  await members.getByRole("button", { name: "学籍 花子 を編集" }).click();
  const input = page.getByTestId("members-form-student-number");
  await input.waitFor({ timeout: 10000 });
  // 開いた直後は空で、effect で既存値が入る。
  await page.waitForFunction(
    () => document.querySelector('[data-testid="members-form-student-number"]')?.value === "1400980",
    null,
    { timeout: 5000 },
  ).catch(async () => fail(`編集画面に学籍番号が出ていない (value=${await input.inputValue()})`));
  ok("メンバー編集画面に学籍番号が表示される");
  await shot(page, "04-member-edit.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log(`PASS (screenshots: ${SHOTS})`);
} finally {
  await browser.close();
}
