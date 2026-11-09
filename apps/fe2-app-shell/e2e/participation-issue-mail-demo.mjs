// Playwright E2E for 参加届の「追加と同時にメールアドレス発行」 against a live demo build,
// as 人事 (members:onboard_mail だけ・identity:admin とロール管理の編集なし).
//   Before: usr_hr_before (新しい鍵なし) は追加しても発行ダイアログが出ない
//   After : usr_hr は 追加する(新規) -> 発行ダイアログ (ローマ字案 / 一般メンバー固定 / Gmail に送る ON)
//           -> 発行する -> 完了トースト -> 名簿の紐付けアカウントに発行アドレス
//   link (招待中との結合) 後も聞かれ、「今はしない」で閉じられる。狭幅も撮る。
// Usage: E2E_BASE=https://dub-demo-<slug>.developershub-site.workers.dev node e2e/participation-issue-mail-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/participation-onboard-e2e";
mkdirSync(SHOTS, { recursive: true });
// モーダルのフェードインが終わってから撮る。
const shot = async (page, name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

async function openList(page, account) {
  await page.goto(`${BASE}/?demo_account=${account}`, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-participation-list").click();
  const table = page.getByTestId("participation-list-table");
  await table.waitFor({ timeout: 20000 });
  return table;
}

async function addAsNew(page, table, name) {
  await table.getByRole("row").filter({ hasText: name }).getByRole("button", { name: "追加する" }).click();
  await page.getByTestId("participation-resolve-create").click();
}

const browser = await chromium.launch();
try {
  const errors = [];
  const newPage = async () => {
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    return page;
  };

  // Before: 新しい鍵の無い人事には聞かない
  {
    const page = await newPage();
    const table = await openList(page, "usr_hr_before");
    await addAsNew(page, table, "田中 実");
    await table.getByRole("row").filter({ hasText: "田中 実" }).getByText("追加済").waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    if (await page.getByTestId("participation-issue-mail-dialog").count()) fail("鍵なしの人事に発行ダイアログが出た");
    ok("Before: usr_hr_before は追加しても発行ダイアログが出ない");
    await shot(page, "00-before-no-dialog.png");
  }

  // After: 人事 (members:onboard_mail) は 1 回で発行まで
  const page = await newPage();
  const table = await openList(page, "usr_hr");
  await addAsNew(page, table, "田中 実");
  const dialog = page.getByTestId("participation-issue-mail-dialog");
  await dialog.waitFor({ timeout: 10000 });
  const local = await page.getByTestId("participation-issue-mail-localpart").inputValue();
  if (local !== "minoru.tanaka") fail(`localPart default = ${local}`);
  const fixed = await page.getByTestId("participation-issue-mail-role-fixed").textContent();
  if (!fixed?.includes("一般メンバー（固定）")) fail(`role text = ${fixed}`);
  if (!(await page.getByTestId("participation-issue-mail-send").isChecked())) fail("Gmail に送る が既定 ON でない");
  ok("After: usr_hr に発行ダイアログ; ローマ字案 / 一般メンバー固定 / Gmail に送る ON");
  await shot(page, "01-issue-dialog.png");

  await page.getByTestId("participation-issue-mail-submit").click();
  await dialog.waitFor({ state: "detached", timeout: 10000 });
  await page.getByText(/minoru\.tanaka@developershub\.jp（ログイン情報を .+ に送りました）/).first().waitFor({ timeout: 5000 });
  ok("発行する -> 完了トーストに発行アドレスと送信先");
  await shot(page, "02-issued-toast.png");

  // link 後も聞かれる -> 狭幅で撮ってから「今はしない」
  const tamura = table.getByRole("row").filter({ hasText: "田村 未" });
  await tamura.getByRole("button", { name: "追加する" }).click();
  await page.getByRole("button", { name: "この人に結びつける" }).first().click();
  await dialog.waitFor({ timeout: 10000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "03-issue-dialog-narrow.png");
  await dialog.screenshot({ path: join(SHOTS, "03b-dialog-narrow-only.png") });
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.getByTestId("participation-issue-mail-later").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  ok("link 後も発行を聞かれる; 今はしない で閉じる");

  // 名簿で 田中 実 が発行アドレスのアカウントに紐付いている
  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  const members = page.getByTestId("members-table");
  await members.waitFor({ timeout: 20000 });
  const row = members.getByRole("row").filter({ hasText: "田中 実" });
  await row.waitFor({ timeout: 10000 });
  if (!(await row.getByText(/minoru\.tanaka/).count())) fail("名簿の 田中 実 に発行アカウントが紐付いていない");
  ok("名簿: 田中 実 の紐付けアカウント = 発行アドレス");
  await shot(page, "04-roster-linked.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
