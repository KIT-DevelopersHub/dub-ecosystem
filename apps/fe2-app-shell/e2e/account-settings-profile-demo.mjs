// Playwright E2E: アカウント設定で運営名簿の自分の情報 (Member) が全部見られる/直せることを live demo で確認する。
// ⚙ -> アカウント設定 -> 本人の情報 (名簿の氏名から姓/名が埋まる) + 運営での情報 (役割/ステータス/チーム/リーダー)
// -> 連絡先と学科を直して保存 -> 開き直して残る -> 運営名簿の自分の行にも同じ値が出る。
// Usage: E2E_BASE=https://dub-demo-account-settings-profile.developershub-site.workers.dev node e2e/account-settings-profile-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "account-settings-profile-e2e");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };
const expectText = async (loc, want, what) => {
  const got = (await loc.textContent())?.trim() ?? "";
  if (!got.includes(want)) fail(`${what}: "${want}" を期待したが "${got}"`);
  ok(`${what} = ${got}`);
};

const openAccount = async (page) => {
  await page.getByTestId("fe2-settings-menu").getByRole("button").first().click();
  await page.getByRole("menuitem", { name: "アカウント設定" }).click();
  const dlg = page.getByTestId("fe2-account-settings");
  await dlg.getByTestId("fe2-account-ops-role").waitFor({ timeout: 10000 });
  return dlg;
};

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: 'div[role="note"]{display:none !important}' });

  // 1. 運営での情報 (名簿で管理者が設定・閲覧のみ)
  let dlg = await openAccount(page);
  await expectText(dlg.getByTestId("fe2-account-ops-role"), "副代表", "担当・役割");
  await expectText(dlg.getByTestId("fe2-account-ops-status"), "通常メンバー", "ステータス");
  await expectText(dlg.getByTestId("fe2-account-ops-teams"), "統括チーム", "所属チーム");
  await expectText(dlg.getByTestId("fe2-account-ops-leader"), "なし", "リーダー");
  if ((await dlg.getByTestId("fe2-account-contact").inputValue()) !== "kota@developershub.jp") fail("連絡先が名簿の値で埋まらない");
  ok("連絡先が名簿の値で埋まる");

  // 2. 本人の情報 (名簿と同じ値。姓/名 未分割の旧データは氏名から埋まる)
  if ((await dlg.getByTestId("fe2-part-lastName").inputValue()) !== "高岡") fail("苗字が名簿の氏名から埋まらない");
  if ((await dlg.getByTestId("fe2-part-firstName").inputValue()) !== "己太朗") fail("名前が名簿の氏名から埋まらない");
  if ((await dlg.getByTestId("fe2-part-department").inputValue()) !== "情報工学科") fail("学科が名簿の値と違う");
  if ((await dlg.getByTestId("fe2-part-gmail").inputValue()) !== "takaoka.demo@gmail.com") fail("Gmail が名簿の値と違う");
  ok("本人の情報が名簿の値 (氏名/学科/Gmail) で埋まる");
  if (!(await dlg.getByTestId("fe2-account-settings-save").isDisabled())) fail("開いただけで保存が押せる (未変更なのに dirty)");
  ok("開いただけでは保存できない (未変更扱い)");
  await shot(page, "1-account-settings-before.png");

  // 3. 連絡先と学科を直して保存
  await dlg.getByTestId("fe2-account-contact").fill("@kota-slack");
  await dlg.getByTestId("fe2-part-department").fill("電気電子工学科");
  await dlg.getByTestId("fe2-account-settings-save").click();
  await dlg.waitFor({ state: "hidden", timeout: 10000 });
  ok("保存して閉じる");

  // 4. 開き直しても残る
  dlg = await openAccount(page);
  if ((await dlg.getByTestId("fe2-account-contact").inputValue()) !== "@kota-slack") fail("連絡先が保存されていない");
  if ((await dlg.getByTestId("fe2-part-department").inputValue()) !== "電気電子工学科") fail("学科が保存されていない");
  ok("開き直しても連絡先/学科が残る");
  await shot(page, "2-account-settings-after.png");
  await dlg.getByTestId("fe2-account-settings-cancel").click();

  // 5. 運営名簿の自分の行にも同じ値
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  const table = page.getByTestId("members-table");
  await table.waitFor({ timeout: 20000 });
  const row = table.locator("tr", { hasText: "高岡" }).first();
  await expectText(row, "電気電子工学科", "名簿の自分の行の学科");
  await shot(page, "3-roster-row.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log(`PASS (screenshots: ${SHOTS})`);
} finally {
  await browser.close();
}
