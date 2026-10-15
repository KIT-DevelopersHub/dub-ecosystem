// Playwright E2E for 参加届の「追加と同時にメールアドレス発行」 against a live demo build.
// Home -> 運営メンバー -> 回答一覧 -> 追加する(新規) -> 発行ダイアログ(ローマ字案/member 既定) -> 発行する
// -> 名簿の紐付けアカウントに発行アドレス. 招待中への結合(link)後も同じく聞かれること、「今はしない」も確認.
// Usage: E2E_BASE=https://dub-demo-participation-issue-mail.developershub-site.workers.dev node e2e/participation-issue-mail-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/participation-issue-mail-e2e");
mkdirSync(SHOTS, { recursive: true });
// モーダルのフェードインが終わってから撮る。
const shot = async (page, name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-participation-list").click();
  const table = page.getByTestId("participation-list-table");
  await table.waitFor({ timeout: 20000 });
  ok("home -> 回答一覧 reachable");

  // 1) 新規で追加 -> 発行する
  const tanaka = table.getByRole("row").filter({ hasText: "田中 実" });
  await tanaka.getByRole("button", { name: "追加する" }).click();
  await page.getByTestId("participation-resolve-create").click();
  const dialog = page.getByTestId("participation-issue-mail-dialog");
  await dialog.waitFor({ timeout: 10000 });
  const local = await page.getByTestId("participation-issue-mail-localpart").inputValue();
  if (local !== "minoru.tanaka") fail(`localPart default = ${local}`);
  await page.getByLabel("member", { exact: true }).waitFor();
  if (!(await page.getByLabel("member", { exact: true }).isChecked())) fail("member role not preselected");
  ok("追加後に発行ダイアログ; ローマ字案 minoru.tanaka / member 既定");
  await shot(page, "01-issue-dialog.png");

  await page.getByTestId("participation-issue-mail-submit").click();
  await dialog.waitFor({ state: "detached", timeout: 10000 });
  await page.getByText("minoru.tanaka@developershub.jp").first().waitFor({ timeout: 5000 });
  ok("発行する -> 完了トーストに発行アドレス");
  await shot(page, "02-issued-toast.png");

  // 2) 招待中との結合(link)でも聞かれる -> 狭幅で撮ってから「今はしない」
  const tamura = table.getByRole("row").filter({ hasText: "田村 未" });
  await tamura.getByRole("button", { name: "追加する" }).click();
  await page.getByRole("button", { name: "この人に結びつける" }).first().click();
  await dialog.waitFor({ timeout: 10000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "03-issue-dialog-narrow.png");
  await page.getByTestId("participation-issue-mail-dialog").screenshot({ path: join(SHOTS, "03b-dialog-narrow-only.png") });
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.getByTestId("participation-issue-mail-later").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  ok("link 後も発行を聞かれる; 今はしない で閉じる");

  // 3) 名簿で 田中 実 が発行アドレスのアカウントに紐付いている
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
