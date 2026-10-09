// Playwright E2E for 参加届の名列番号 against a live demo build.
// Home -> 運営メンバー -> 参加届タブ -> 形式エラー/全角正規化で送信 -> 回答一覧に名列番号列 -> 追加する(新規) -> 名簿に引き継ぎ.
// Usage: E2E_BASE=https://dub-demo-roster-number.developershub-site.workers.dev node e2e/participation-roster-number-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/participation-roster-number-e2e");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-participation").click();
  await page.getByTestId("participation-roster-number").waitFor({ timeout: 20000 });
  ok("home -> 参加届 reachable; 名列番号 field present");

  await page.getByTestId("participation-last-name").fill("名列");
  await page.getByTestId("participation-first-name").fill("花子");
  await page.getByTestId("participation-school-email").fill("hanako@school.ac.jp");
  await page.getByTestId("participation-gmail").fill("hanako@gmail.com");
  await page.getByTestId("participation-roster-number").fill("3EP2");
  await page.getByTestId("participation-submit").click();
  await page.getByText("名列番号は 3EP2-26 の形式で入力してください").waitFor({ timeout: 5000 });
  ok("invalid format blocked with message");
  await shot(page, "01-form-error.png");

  await page.getByTestId("participation-roster-number").fill("３ep２ー２６");
  await page.getByTestId("participation-submit").click();
  await page.getByTestId("participation-thanks").waitFor({ timeout: 10000 });
  ok("submitted with full-width input");

  await page.getByTestId("member-roster-subnav-tab-participation-list").click();
  const table = page.getByTestId("participation-list-table");
  await table.waitFor({ timeout: 20000 });
  await table.getByRole("columnheader", { name: "名列番号" }).waitFor();
  const row = table.getByRole("row").filter({ hasText: "名列 花子" });
  if (!(await row.getByText("3EP2-26").count())) fail("submitted 名列番号 not normalized/shown in 回答一覧");
  if (!(await table.getByText("2EE1-15").count())) fail("seeded 名列番号 not shown");
  ok("回答一覧 has 名列番号 column; 全角入力が 3EP2-26 に正規化");
  await shot(page, "02-list.png");

  await row.getByRole("button", { name: "追加する" }).click();
  await page.getByTestId("participation-resolve-create").click();
  await row.getByText(/追加済/).waitFor({ timeout: 10000 });
  ok("追加する -> 新規で追加 confirmed");

  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  const members = page.getByTestId("members-table");
  await members.waitFor({ timeout: 20000 });
  await page.getByTestId("member-roster-search").fill("3EP2-26");
  await members.getByText("名列 花子").waitFor({ timeout: 10000 });
  ok("確定したメンバーに名列番号が引き継がれ、名簿で検索できる");
  await shot(page, "03-members.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
