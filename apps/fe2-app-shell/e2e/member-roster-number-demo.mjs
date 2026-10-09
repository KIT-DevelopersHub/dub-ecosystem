// Playwright E2E for 名列番号 (rosterNumber) against a live demo build.
// Home -> 運営メンバー tile -> 一覧に名列番号列 -> 追加フォームで形式エラー/正規化保存 -> 一覧に反映.
// Usage: E2E_BASE=https://dub-demo-roster-number.developershub-site.workers.dev node e2e/member-roster-number-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/member-roster-number-e2e");
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
  const teamRow = page.getByTestId("members-teamrow-member_h2");
  await teamRow.waitFor({ timeout: 20000 });
  if (!/[1-4][A-Z]{2}[1-3]-\d{2}/.test(await teamRow.innerText())) fail("チーム別 row lacks 名列番号");
  ok("home -> 運営メンバー reachable; チーム別 row shows 名列番号");
  await shot(page, "00-teams.png");

  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  await page.getByTestId("members-table").waitFor({ timeout: 20000 });

  const table = page.getByTestId("members-table");
  await table.getByRole("columnheader", { name: "名列番号" }).waitFor();
  if (!(await table.getByText(/^[1-4][A-Z]{2}[1-3]-\d{2}$/).first().count())) fail("seeded 名列番号 not shown");
  ok("一覧 has 名列番号 column with seeded values");
  await shot(page, "01-list.png");

  await page.getByRole("button", { name: /メンバーを追加|追加/ }).first().click();
  const dialog = page.getByTestId("members-form-dialog");
  await dialog.waitFor();
  await dialog.getByTestId("members-form-last-name").fill("名列");
  await dialog.getByTestId("members-form-first-name").fill("テスト");
  await dialog.getByTestId("members-form-roster-number").fill("3EP2");
  await dialog.getByTestId("members-form-submit").click();
  await dialog.getByText("名列番号は 3EP2-26 の形式で入力してください").waitFor({ timeout: 5000 });
  ok("invalid format blocked with message");
  await shot(page, "02-form-error.png");

  await dialog.getByTestId("members-form-roster-number").fill("３ep２ー２６");
  await dialog.getByTestId("members-form-submit").click();
  await dialog.waitFor({ state: "hidden", timeout: 10000 });
  await page.getByTestId("member-roster-search").fill("3EP2-26");
  await table.getByText("3EP2-26").first().waitFor({ timeout: 10000 });
  if (!(await table.getByText("名列 テスト").count())) fail("new member row not found by 名列番号 search");
  ok("全角入力が 3EP2-26 に正規化されて保存・検索できる");
  await shot(page, "03-saved.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
