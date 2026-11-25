// Playwright E2E: 面談申し込みフォームの回答 -> 人事の「入力済みリンク」-> 参加届が入力済みで開く。
// 公開フォームは参加届と同じ 姓/名・ふりがな の 2 欄 + 学年の選択肢で、リンクの中身は URL から消える。
// Usage: E2E_BASE=https://fe2-demo.developershub-site.workers.dev node e2e/hr-form-participation-prefill-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "hr-form-prefill-e2e");
mkdirSync(SHOTS, { recursive: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => {
  throw new Error(m);
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // 公開フォーム: 参加届と同じ形
  await page.goto(`${BASE}/interview-apply`, { waitUntil: "networkidle" });
  const last = page.getByTestId("interview-form-public-q-last_name");
  const first = page.getByTestId("interview-form-public-q-first_name");
  await last.waitFor({ timeout: 20000 });
  const [a, b] = [await last.boundingBox(), await first.boundingBox()];
  if (!a || !b || Math.abs(a.y - b.y) > 2 || a.x >= b.x) fail("姓と名が同じ行に並んでいない");
  ok("公開フォームの姓/名が 2 欄で同じ行に並ぶ");
  await page.screenshot({ path: join(SHOTS, "01-interview-form.png"), fullPage: true });

  // 人事: seed の応募者 (森 結菜) の詳細からリンクをコピー
  await page.goto(`${BASE}/hr`, { waitUntil: "networkidle" });
  await page.getByText("森 結菜").first().click({ timeout: 20000 });
  await page.getByTestId("fe2-hr-participation-link").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, "02-applicant-drawer.png"), fullPage: true });
  const link = await page.evaluate(() => navigator.clipboard.readText());
  if (!/\/participate#prefill=/.test(link)) fail(`リンクの形が違う: ${link}`);
  ok("応募者の詳細から入力済みリンクをコピーできる");

  // 別タブ (ログイン前提なし) で開く
  const fresh = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  fresh.on("pageerror", (e) => errors.push(String(e)));
  await fresh.goto(link, { waitUntil: "networkidle" });
  await fresh.getByTestId("participation-prefilled").waitFor({ timeout: 20000 });
  const want = {
    "participation-last-name": "森",
    "participation-first-name": "結菜",
    "participation-last-name-kana": "もり",
    "participation-first-name-kana": "ゆいな",
    "participation-last-name-romaji": "Mori",
    "participation-first-name-romaji": "Yuina",
    "participation-school-email": "yuina@example.com",
    "participation-department": "情報工学科",
  };
  for (const [id, value] of Object.entries(want)) {
    const got = await fresh.getByTestId(id).inputValue();
    if (got !== value) fail(`${id}: ${got} != ${value}`);
  }
  ok("参加届が入力済みで開く (姓名・ふりがな・ローマ字・メール・学科)");
  if (new URL(fresh.url()).hash !== "") fail(`URL に個人情報が残っている: ${fresh.url()}`);
  ok("読み込んだあと URL から入力内容が消える");
  await fresh.screenshot({ path: join(SHOTS, "03-participation-prefilled.png"), fullPage: true });

  // 足りない項目だけ入れて提出できる
  await fresh.getByTestId("participation-gmail").fill("yuina@gmail.com");
  const select = async (id, label) => {
    const el = fresh.getByTestId(id);
    if ((await el.evaluate((n) => n.tagName)) === "SELECT") await el.selectOption({ label });
    else {
      await el.click();
      await fresh.getByRole("option", { name: label }).click();
    }
  };
  await select("participation-position", "Member");
  const team = fresh.getByTestId("participation-team");
  if (await team.count()) await select("participation-team", "まだ決まっていない");
  await fresh.getByTestId("participation-submit").click();
  await fresh.getByTestId("participation-thanks").waitFor({ timeout: 10000 });
  ok("残りの項目だけ入力して提出できる");

  if (errors.length) fail(`pageerror: ${errors.join(" | ")}`);
  console.log(`PASS (screenshots: ${SHOTS})`);
} finally {
  await browser.close();
}
